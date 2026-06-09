# Clipper Worker

Railway service — handles the full video pipeline:
`URL → download → transcribe → AI clip scoring → FFmpeg cut + captions`

## Environment Variables

Set these in Railway:

```
OPENAI_API_KEY=sk-...           # Whisper transcription + GPT-4o clip scoring
WORKER_API_KEY=your-secret      # Shared secret between this worker and your Next.js app
PORT=3000                       # Railway sets this automatically

R2_ACCOUNT_ID=abc123            # Cloudflare account ID (found in R2 dashboard sidebar)
R2_ACCESS_KEY_ID=...            # R2 API token access key
R2_SECRET_ACCESS_KEY=...        # R2 API token secret
R2_BUCKET_NAME=clipper-clips    # Your R2 bucket name
R2_PUBLIC_URL=https://clips.yourdomain.com  # Custom domain OR r2.dev public URL
```

## R2 Setup (one-time)

1. Go to Cloudflare dashboard → R2
2. Create bucket: `clipper-clips`
3. Under bucket settings → enable "Public access" (or connect a custom domain)
4. Go to R2 → Manage R2 API Tokens → Create Token with `Object Read & Write` on your bucket
5. Copy Account ID, Access Key ID, Secret Access Key into Railway env vars
6. Set a lifecycle rule: delete objects after 24h (optional but saves cost)

Clips are uploaded to `clips/{jobId}/clip_N.mp4` and returned as public URLs.

## API

### POST /job
Start a new clip job.

```json
// Request
{
  "url": "https://www.youtube.com/watch?v=...",
  "options": {
    "maxClips": 3,
    "minDuration": 30,
    "maxDuration": 90
  }
}

// Response
{
  "jobId": "uuid",
  "status": "queued"
}
```

Headers: `x-api-key: your-secret`

### GET /job/:id
Poll job status.

```json
// While running
{ "id": "uuid", "status": "running", "step": "transcribing" }

// Done
{
  "id": "uuid",
  "status": "done",
  "clips": [
    {
      "index": 1,
      "title": "The moment everything changed",
      "hook": "Nobody talks about this but...",
      "score": 97,
      "start": 42.1,
      "end": 108.4,
      "duration": 66.3,
      "file": "/tmp/clips/{jobId}/clip_1.mp4"
    }
  ]
}

// Failed
{ "id": "uuid", "status": "failed", "error": "Download failed: ..." }
```

## Status flow

`queued → running (downloading) → running (transcribing) → running (scoring) → running (cutting) → done`

## Notes

- Videos capped at 1 hour, 500MB download
- Output clips are vertical 9:16 (1080×1920) for TikTok/Reels/Shorts
- Files live in `/tmp/clips/{jobId}/` — serve them or upload to R2/Supabase Storage
- For production: swap in-memory job store for Redis or Supabase
- Cleanup: call `cleanupJob(jobId)` from worker.js after client downloads
