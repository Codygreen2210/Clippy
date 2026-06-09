const express = require('express');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const { processVideo } = require('./worker');

const app = express();
app.use(express.json());

// In-memory job store (replace with Redis/Supabase for production)
const jobs = new Map();

// Auth middleware
function requireAuth(req, res, next) {
  const key = req.headers['x-api-key'];
  if (key !== process.env.WORKER_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// POST /job — start a new clip job
app.post('/job', requireAuth, async (req, res) => {
  const { url, options = {} } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'url is required' });
  }

  const jobId = uuidv4();

  jobs.set(jobId, {
    id: jobId,
    status: 'queued',
    url,
    options,
    createdAt: Date.now(),
    clips: null,
    error: null,
  });

  // Run async — don't await
  processVideo(jobId, url, options, jobs).catch((err) => {
    const job = jobs.get(jobId);
    if (job) {
      job.status = 'failed';
      job.error = err.message;
    }
  });

  res.json({ jobId, status: 'queued' });
});

// GET /job/:id — poll job status
app.get('/job/:id', requireAuth, (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

// POST /frame — extract first frame from video URL
app.post('/frame', requireAuth, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });

  const tmpDir = path.join('/tmp/frames', require('crypto').randomUUID());
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    const videoPath = path.join(tmpDir, 'source.mp4');
    const framePath = path.join(tmpDir, 'frame.jpg');

    // Download just first 10 seconds to get the frame fast
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

    // Extract first frame
    await require('util').promisify(require('child_process').exec)(
      `ffmpeg -i "${videoPath}" -vframes 1 -q:v 2 "${framePath}" -y`
    );

    // Get video dimensions
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
  res.json({ ok: true, jobs: jobs.size });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Clipper worker listening on :${PORT}`);
});
