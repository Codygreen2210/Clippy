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

async function processVideo(jobId, url, options, supabase) {
  // faceCamBox: { x, y, w, h, video_w, video_h } — set by user in UI
  const setStatus = async (status, extra = {}) => {
    console.log(`[${jobId}] ${status}`, extra.step || '');
    await supabase.from('jobs').update({ status, ...extra }).eq('id', jobId);
  };

  const workDir = path.join(TMP, jobId);
  fs.mkdirSync(workDir, { recursive: true });

  try {
    await setStatus('running', { step: 'downloading' });
    const videoPath = await downloadVideo(url, workDir);

    await setStatus('running', { step: 'transcribing' });
    const transcript = await transcribeVideo(videoPath);

    await setStatus('running', { step: 'scoring' });
    const clipWindows = await scoreAndPickClips(transcript, options);

    await setStatus('running', { step: 'cutting' });
    const clips = await cutAndCaptionClips(videoPath, clipWindows, workDir, transcript, options.faceCamBox || null);

    await setStatus('running', { step: 'uploading' });
    const uploadedClips = await uploadClipsToR2(clips, jobId);

    cleanupJob(jobId);

    await setStatus('done', { clips: uploadedClips, step: 'done' });
  } catch (err) {
    await setStatus('failed', { error: err.message, step: 'error' });
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

// ─── Step 4: Cut + caption ────────────────────────────────────────────────────

async function cutAndCaptionClips(videoPath, clipWindows, workDir, transcript, faceCamBox) {
  const results = [];
  const faceCam = (faceCamBox && faceCamBox.w > 0 && faceCamBox.h > 0) ? faceCamBox : null;

  for (let i = 0; i < clipWindows.length; i++) {
    const clip = clipWindows[i];
    const rawPath = path.join(workDir, `raw_${i + 1}.mp4`);
    const outputPath = path.join(workDir, `clip_${i + 1}.mp4`);
    const assPath = `/tmp/c${i}.ass`;

    // Build ASS subtitle file — no path escaping issues, supports rich styling
    const ass = buildASS(transcript.segments, clip.start, clip.end);
    fs.writeFileSync(assPath, ass);

    // Pass 1: Cut and reformat to 9:16 (1080x1920)
    if (faceCam) {
      const { x, y, w, h } = faceCam;
      const vf = [
        `[0:v]split=2[a][b]`,
        `[a]crop=${w}:${h}:${x}:${y},scale=1080:960[top]`,
        `[b]scale=1920:1080,crop=1080:1080:420:0,scale=1080:960[bot]`,
        `[top][bot]vstack=inputs=2[v]`,
      ].join(';');
      await execAsync(
        `ffmpeg -ss ${clip.start} -to ${clip.end} -i "${videoPath}" -filter_complex "${vf}" -map "[v]" -map 0:a -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k -movflags +faststart "${rawPath}" -y`,
        { timeout: 180_000 }
      );
    } else {
      // Blur background fill — no cropping, full frame visible
      const vf = [
        `[0:v]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2[fg]`,
        `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=20:5[bg]`,
        `[bg][fg]overlay=(W-w)/2:(H-h)/2[v]`,
      ].join(';');
      await execAsync(
        `ffmpeg -ss ${clip.start} -to ${clip.end} -i "${videoPath}" -filter_complex "${vf}" -map "[v]" -map 0:a -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k -movflags +faststart "${rawPath}" -y`,
        { timeout: 180_000 }
      );
    }

    // Pass 2: Burn ASS subtitles
    await execAsync(
      `ffmpeg -i "${rawPath}" -vf "ass='${assPath}'" -c:v libx264 -preset fast -crf 23 -c:a copy -movflags +faststart "${outputPath}" -y`,
      { timeout: 180_000 }
    );

    fs.unlinkSync(rawPath);
    fs.unlinkSync(assPath);

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

// ─── ASS subtitle builder ───────────────────────────────────────────────────────

function buildASS(segments, clipStart, clipEnd) {
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,56,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,3,0,2,60,60,80,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const relevant = segments.filter(s => s.end > clipStart && s.start < clipEnd);
  
  const events = relevant.map(seg => {
    const start = Math.max(0, seg.start - clipStart);
    const end = Math.min(clipEnd - clipStart, seg.end - clipStart);
    return `Dialogue: 0,${toASSTime(start)},${toASSTime(end)},Default,,0,0,0,,${seg.text.trim()}`;
  }).join('\n');

  return header + events + '\n';
}

function toASSTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const cs = Math.round((seconds % 1) * 100);
  return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}.${String(cs).padStart(2,'0')}`;
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
