const { execSync, exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');
const FormData = require('form-data');
const axios = require('axios');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

const execAsync = promisify(exec);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const TMP = '/tmp/clips';
const MAX_VIDEO_DURATION_SECONDS = 3600;

// ─── R2 client ────────────────────────────────────────────────────────────────

const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const R2_BUCKET = process.env.R2_BUCKET_NAME;
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL;

// ─── Main pipeline ────────────────────────────────────────────────────────────

async function processVideo(jobId, url, options, jobs) {
  // faceCamBox: { x, y, w, h, video_w, video_h } — set by user in UI
  const setStatus = (status, extra = {}) => {
    const job = jobs.get(jobId);
    Object.assign(job, { status, ...extra });
    console.log(`[${jobId}] ${status}`, extra.step || '');
  };

  const workDir = path.join(TMP, jobId);
  fs.mkdirSync(workDir, { recursive: true });

  try {
    setStatus('running', { step: 'downloading' });
    const videoPath = await downloadVideo(url, workDir);

    setStatus('running', { step: 'transcribing' });
    const transcript = await transcribeVideo(videoPath);

    setStatus('running', { step: 'scoring' });
    const clipWindows = await scoreAndPickClips(transcript, options);

    setStatus('running', { step: 'cutting' });
    const clips = await cutAndCaptionClips(videoPath, clipWindows, workDir, transcript, options.faceCamBox || null);

    setStatus('running', { step: 'uploading' });
    const uploadedClips = await uploadClipsToR2(clips, jobId);

    cleanupJob(jobId);

    setStatus('done', { clips: uploadedClips, step: 'done' });
  } catch (err) {
    setStatus('failed', { error: err.message, step: 'error' });
    throw err;
  }
}


// ─── Step 1: Download ─────────────────────────────────────────────────────────

async function downloadVideo(url, workDir) {
  const outputPath = path.join(workDir, 'source.mp4');

  // Write cookies to temp file
  const cookiesPath = path.join(workDir, 'cookies.txt');
  if (process.env.YOUTUBE_COOKIES) {
    fs.writeFileSync(cookiesPath, process.env.YOUTUBE_COOKIES);
  }

  const cmd = [
    'yt-dlp',
    '--format', '"bestvideo[height<=1080]+bestaudio/best"',
    '--js-runtimes', 'node',
    '--merge-output-format', 'mp4',
    '--max-filesize', '500m',
    '--no-playlist',
    process.env.YOUTUBE_COOKIES ? `--cookies "${cookiesPath}"` : '',
    '--output', `"${outputPath}"`,
    `"${url}"`,
  ].filter(Boolean).join(' ');

  await execAsync(cmd, { timeout: 300_000 });

  if (!fs.existsSync(outputPath)) {
    throw new Error('Download failed: output file not found');
  }

  const duration = getVideoDuration(outputPath);
  if (duration > MAX_VIDEO_DURATION_SECONDS) {
    throw new Error(`Video too long: ${Math.round(duration / 60)} minutes (max 60)`);
  }

  return outputPath;
}

function getVideoDuration(videoPath) {
  const result = execSync(
    `ffprobe -v error -show_entries format=duration -of csv=p=0 "${videoPath}"`
  ).toString().trim();
  return parseFloat(result);
}

// ─── Step 2: Transcribe ───────────────────────────────────────────────────────

async function transcribeVideo(videoPath) {
  const audioPath = videoPath.replace('.mp4', '.mp3');
  await execAsync(
    `ffmpeg -i "${videoPath}" -vn -ar 16000 -ac 1 -b:a 64k "${audioPath}" -y`
  );

  const audioBuffer = fs.readFileSync(audioPath);
  const formData = new FormData();
  formData.append('file', audioBuffer, {
    filename: 'audio.mp3',
    contentType: 'audio/mpeg',
  });
  formData.append('model', 'whisper-1');
  formData.append('response_format', 'verbose_json');
  formData.append('timestamp_granularities[]', 'segment');

  const response = await axios.post(
    'https://api.openai.com/v1/audio/transcriptions',
    formData,
    {
      headers: {
        ...formData.getHeaders(),
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      maxBodyLength: Infinity,
      timeout: 300_000,
    }
  );

  fs.unlinkSync(audioPath);
  return response.data;
}

// ─── Step 3: Score + pick clips ───────────────────────────────────────────────

async function scoreAndPickClips(transcript, options = {}) {
  const { maxClips = 3, minDuration = 30, maxDuration = 90 } = options;

  const segmentText = transcript.segments
    .map((s) => `[${s.start.toFixed(1)}s → ${s.end.toFixed(1)}s] ${s.text}`)
    .join('\n');

  const prompt = `You are an expert short-form video editor. Analyze this transcript and identify the ${maxClips} best clip windows for viral short-form content (TikTok, Reels, Shorts).

TRANSCRIPT WITH TIMESTAMPS:
${segmentText}

RULES:
- Each clip must be ${minDuration}–${maxDuration} seconds long
- Prioritize: hooks, surprising facts, emotional moments, clear value delivery, complete thoughts
- Clips must start and end at natural speech boundaries (not mid-sentence)
- No overlapping clips

Respond ONLY with valid JSON in this exact format:
{
  "clips": [
    {
      "start": 12.5,
      "end": 47.2,
      "title": "Short punchy title for this clip",
      "hook": "First sentence that will appear as hook",
      "score": 95
    }
  ]
}`;

  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: 'json_object' },
    temperature: 0.3,
  });

  const parsed = JSON.parse(response.choices[0].message.content);

  if (!parsed.clips || !Array.isArray(parsed.clips)) {
    throw new Error('AI returned invalid clip format');
  }

  return parsed.clips.sort((a, b) => b.score - a.score).slice(0, maxClips);
}

// ─── Step 4: Cut + caption (with optional face cam split) ───────────────────

// Legacy Vision detection — replaced by manual box selection in UI
async function detectFaceCam_DISABLED(videoPath) {
  // Extract first frame
  const framePath = videoPath.replace('.mp4', '_frame.jpg');
  await execAsync(
    `ffmpeg -i "${videoPath}" -vframes 1 -q:v 2 "${framePath}" -y`
  );

  const imageBuffer = fs.readFileSync(framePath);
  const base64Image = imageBuffer.toString('base64');
  fs.unlinkSync(framePath);

  // Ask Claude Vision to detect the face cam
  const response = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: 'claude-opus-4-5',
      max_tokens: 256,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/jpeg', data: base64Image }
          },
          {
            type: 'text',
            text: `This is a frame from a gaming livestream. There is a face cam (webcam of the streamer) overlaid on the gameplay footage.

Identify the face cam rectangle and return ONLY a JSON object with these fields:
{
  "x": <left edge in pixels>,
  "y": <top edge in pixels>,
  "w": <width in pixels>,
  "h": <height in pixels>,
  "video_w": <total video width in pixels>,
  "video_h": <total video height in pixels>
}

No explanation, just the JSON.`
          }
        ]
      }]
    },
    {
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      timeout: 30_000,
    }
  );

  try {
    const text = response.data.content[0].text.trim();
    const clean = text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch {
    console.log('[facecam] Detection failed, using default layout');
    return null;
  }
}

// ─── Step 4: Cut + caption ────────────────────────────────────────────────────

async function cutAndCaptionClips(videoPath, clipWindows, workDir, transcript, faceCamBox) {
  const results = [];

  // Use manually selected face cam box from UI, or fall back to simple crop
  const faceCam = (faceCamBox && faceCamBox.w > 0 && faceCamBox.h > 0) ? faceCamBox : null;
  if (faceCam) {
    console.log('[facecam] Using manual box:', JSON.stringify(faceCam));
  } else {
    console.log('[facecam] No face cam box — using center crop');
  }

  for (let i = 0; i < clipWindows.length; i++) {
    const clip = clipWindows[i];
    const outputPath = path.join(workDir, `clip_${i + 1}.mp4`);
    const srtPath = path.join(workDir, `clip_${i + 1}.srt`);

    const srt = buildSRT(transcript.segments, clip.start, clip.end);
    fs.writeFileSync(srtPath, srt);

    let vf;

    if (faceCam && faceCam.w > 0 && faceCam.h > 0 && faceCam.x >= 0 && faceCam.y >= 0) {
      const { x, y, w, h, video_w, video_h } = faceCam;

      // Face cam: crop to detected rectangle, scale to 1080x960
      const faceCrop = `crop=${w}:${h}:${x}:${y},scale=1080:960`;

      // Gameplay: use everything outside face cam — crop center of gameplay area
      // Take the full frame, scale to 1080x960, use as background
      const gameplayCrop = `scale=1080:960`;

      // Caption style for bottom half
      const captionStyle = `Fontname=Arial,Fontsize=16,PrimaryColour=&HFFFFFF,OutlineColour=&H000000,Outline=2,Bold=1,Alignment=2,MarginV=20`;
      const safeSrtSplit = `/tmp/s${i}.srt`;
      fs.copyFileSync(srtPath, safeSrtSplit);

      vf = [
        `[0:v]split=2[gameplay_in][face_in]`,
        `[gameplay_in]${gameplayCrop}[gameplay]`,
        `[face_in]${faceCrop}[facecam]`,
        `[facecam][gameplay]vstack=inputs=2[stacked]`,
        `[stacked]subtitles='${safeSrtSplit}':force_style='${captionStyle}'[out]`,
      ].join(';');

      await execAsync(
        `ffmpeg -i "${videoPath}" \
          -ss ${clip.start} -to ${clip.end} \
          -filter_complex "${vf}" \
          -map "[out]" \
          -c:v libx264 -preset fast -crf 23 \
          -c:a aac -b:a 128k \
          -movflags +faststart \
          "${outputPath}" -y`,
        { timeout: 180_000 }
      );
    } else {
      // Fallback: simple center crop to 9:16
      await execAsync(
        `ffmpeg -i "${videoPath}" \
          -ss ${clip.start} -to ${clip.end} \
          -vf "crop=ih*9/16:ih,scale=1080:1920,subtitles='${srtPath.replace(/:/g, '\\:').replace(/'/g, "\\'")}':force_style='Fontname=Arial,Fontsize=18,PrimaryColour=&HFFFFFF,OutlineColour=&H000000,Outline=2,Bold=1,Alignment=2'" \
          -c:v libx264 -preset fast -crf 23 \
          -c:a aac -b:a 128k \
          -movflags +faststart \
          "${outputPath}" -y`,
        { timeout: 180_000 }
      );
    }

    results.push({
      index: i + 1,
      title: clip.title,
      hook: clip.hook,
      score: clip.score,
      start: clip.start,
      end: clip.end,
      duration: clip.end - clip.start,
      file: outputPath,
    });
  }

  return results;
}

// ─── Step 5: Upload to R2 ─────────────────────────────────────────────────────

async function uploadClipsToR2(clips, jobId) {
  const uploaded = [];

  for (const clip of clips) {
    const key = `clips/${jobId}/clip_${clip.index}.mp4`;
    const fileBuffer = fs.readFileSync(clip.file);

    await r2.send(new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      Body: fileBuffer,
      ContentType: 'video/mp4',
      Metadata: {
        jobId,
        title: clip.title,
        score: String(clip.score),
      },
    }));

    const url = `${R2_PUBLIC_URL}/${key}`;
    uploaded.push({
      index: clip.index,
      title: clip.title,
      hook: clip.hook,
      score: clip.score,
      start: clip.start,
      end: clip.end,
      duration: clip.duration,
      url,
    });

    console.log(`[R2] Uploaded clip ${clip.index}: ${url}`);
  }

  return uploaded;
}

// ─── SRT builder ──────────────────────────────────────────────────────────────

function buildSRT(segments, clipStart, clipEnd) {
  const relevant = segments.filter(
    (s) => s.end > clipStart && s.start < clipEnd
  );

  return relevant
    .map((seg, i) => {
      const start = Math.max(0, seg.start - clipStart);
      const end = Math.min(clipEnd - clipStart, seg.end - clipStart);
      return `${i + 1}\n${formatSRTTime(start)} --> ${formatSRTTime(end)}\n${seg.text.trim()}\n`;
    })
    .join('\n');
}

function formatSRTTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.round((seconds % 1) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

// ─── Cleanup ──────────────────────────────────────────────────────────────────

function cleanupJob(jobId) {
  const workDir = path.join(TMP, jobId);
  if (fs.existsSync(workDir)) {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

async function deleteJobFromR2(jobId) {
  const keys = Array.from({ length: 5 }, (_, i) => `clips/${jobId}/clip_${i + 1}.mp4`);
  await Promise.allSettled(
    keys.map((key) =>
      r2.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key }))
    )
  );
}

module.exports = { processVideo, cleanupJob, deleteJobFromR2 };
