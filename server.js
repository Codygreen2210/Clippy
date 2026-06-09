const express = require('express');
const { v4: uuidv4 } = require('uuid');
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

// GET /health
app.get('/health', (req, res) => {
  res.json({ ok: true, jobs: jobs.size });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Clipper worker listening on :${PORT}`);
});
