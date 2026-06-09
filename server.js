const express = require('express');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const { processVideo } = require('./worker');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

function requireAuth(req, res, next) {
  const key = req.headers['x-api-key'];
  if (key !== process.env.WORKER_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// POST /job
app.post('/job', requireAuth, async (req, res) => {
  const { url, options = {} } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });

  const jobId = uuidv4();
  const job = {
    id: jobId,
    status: 'queued',
    url,
    options,
    clips: null,
    error: null,
    step: null,
    created_at: Date.now(),
  };

  await supabase.from('jobs').insert(job);

  processVideo(jobId, url, options, supabase).catch(async (err) => {
    await supabase.from('jobs').update({ status: 'failed', error: err.message }).eq('id', jobId);
  });

  res.json({ jobId, status: 'queued' });
});

// GET /job/:id
app.get('/job/:id', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('jobs')
    .select('*')
    .eq('id', req.params.id)
    .single();

  if (error || !data) return res.status(404).json({ error: 'Job not found' });
  res.json(data);
});

// POST /frame
app.post('/frame', requireAuth, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });

  const tmpDir = path.join('/tmp/frames', require('crypto').randomUUID());
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    const videoPath = path.join(tmpDir, 'source.mp4');
    const framePath = path.join(tmpDir, 'frame.jpg');
    const cookiesPath = path.join(tmpDir, 'cookies.txt');

    if (process.env.YOUTUBE_COOKIES) {
      fs.writeFileSync(cookiesPath, process.env.YOUTUBE_COOKIES);
    }

    const dlCmd = [
      'yt-dlp',
      '--format', '"bestvideo[height<=1080]+bestaudio/best"',
      '--no-playlist',
      '--js-runtimes', 'node',
      process.env.YOUTUBE_COOKIES ? `--cookies "${cookiesPath}"` : '',
      '--output', `"${videoPath}"`,
      `"${url}"`,
    ].filter(Boolean).join(' ');

    await require('util').promisify(require('child_process').exec)(dlCmd, { timeout: 120_000 });

    await require('util').promisify(require('child_process').exec)(
      `ffmpeg -i "${videoPath}" -vframes 1 -q:v 2 "${framePath}" -y`
    );

    const probeResult = await require('util').promisify(require('child_process').exec)(
      `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "${videoPath}"`
    );
    const [width, height] = probeResult.stdout.trim().split(',').map(Number);
    const frameBase64 = fs.readFileSync(framePath).toString('base64');
    fs.rmSync(tmpDir, { recursive: true, force: true });

    res.json({ frame: frameBase64, width, height });
  } catch (err) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    res.status(500).json({ error: err.message });
  }
});

// GET /health
app.get('/health', (req, res) => {
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Clipper worker listening on :${PORT}`));
