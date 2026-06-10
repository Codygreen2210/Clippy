const express = require('express');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const { promisify } = require('util');
const exec = promisify(require('child_process').exec);
const { processVideo, extendClip } = require('./worker');
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

// POST /extend — re-render one clip with an adjusted window
app.post('/extend', requireAuth, async (req, res) => {
  const { jobId, clipIndex, start, end } = req.body;
  if (!jobId || typeof clipIndex !== 'number' || typeof start !== 'number' || typeof end !== 'number') {
    return res.status(400).json({ error: 'jobId, clipIndex, start, end are required' });
  }
  if (end - start < 5) {
    return res.status(400).json({ error: 'Clip must be at least 5 seconds' });
  }

  extendClip(jobId, clipIndex, start, end, supabase).catch((err) => {
    console.error(`[extend ${jobId}/${clipIndex}]`, err.message);
  });

  res.json({ ok: true });
});

// POST /frame
app.post('/frame', requireAuth, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });

  const tmpDir = path.join('/tmp/frames', require('crypto').randomUUID());
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    const framePath = path.join(tmpDir, 'frame.jpg');
    const cookiesPath = path.join(tmpDir, 'cookies.txt');

    if (process.env.YOUTUBE_COOKIES) {
      fs.writeFileSync(cookiesPath, process.env.YOUTUBE_COOKIES);
    }

    // For a preview frame we only need a few seconds of a small,
    // single-file format:
    // - Single pre-muxed format = no video+audio merge, so yt-dlp keeps
    //   the extension predictable. (The old command merged bestvideo+
    //   bestaudio WITHOUT --merge-output-format, so yt-dlp wrote
    //   source.webm/mkv and ffmpeg failed on "source.mp4 not found".)
    // - --download-sections grabs only the first 3 seconds, so Preview
    //   stays fast even for hour-long videos.
    // - Output template uses %(ext)s and we look the file up afterward,
    //   so any container works regardless.
    const dlCmd = [
      'yt-dlp',
      '--format', '"best[height<=480][ext=mp4]/best[height<=480]/best"',
      '--no-playlist',
      '--js-runtimes', 'node',
      '--download-sections', '"*0:00-0:03"',
      '--merge-output-format', 'mp4',
      process.env.YOUTUBE_COOKIES ? `--cookies "${cookiesPath}"` : '',
      '--output', `"${path.join(tmpDir, 'source.%(ext)s')}"`,
      `"${url}"`,
    ].filter(Boolean).join(' ');

    await exec(dlCmd, { timeout: 120_000 });

    const downloaded = fs.readdirSync(tmpDir).find(
      (f) => f.startsWith('source.') && !f.endsWith('.part')
    );
    if (!downloaded) {
      throw new Error('Frame download produced no video file');
    }
    const videoPath = path.join(tmpDir, downloaded);

    // -ss 1: skip the first second — frame 0 is often black/fade-in
    await exec(
      `ffmpeg -ss 1 -i "${videoPath}" -vframes 1 -q:v 2 "${framePath}" -y`
    );
    if (!fs.existsSync(framePath)) {
      // Clip shorter than 1s — fall back to the very first frame
      await exec(
        `ffmpeg -i "${videoPath}" -vframes 1 -q:v 2 "${framePath}" -y`
      );
    }

    const probeResult = await exec(
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
