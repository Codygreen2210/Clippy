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
    // ── Pass 1: audio only — much smaller than the full video, and all
    // Whisper needs is audio. A 1-hour video at 128kbps ≈ 55 MB vs ~1 GB
    // for 1080p video. We don't touch the video until we know which clips
    // to pull.
    await setStatus('running', { step: 'downloading' });
    const cookiesPath = writeCookies(workDir);
    const audioFilePath = await downloadAudioOnly(url, workDir, cookiesPath);

    await setStatus('running', { step: 'transcribing' });
    const transcript = await transcribeVideo(audioFilePath);

    // Persist slim transcript data so clips can be re-rendered later.
    const savedTranscript = {
      segments: transcript.segments.map(s => ({ start: s.start, end: s.end, text: s.text })),
      words: (transcript.words || []).map(w => ({ word: w.word, start: w.start, end: w.end })),
    };
    await setStatus('running', { step: 'scoring', segments: savedTranscript });
    const clipWindows = await scoreAndPickClips(transcript, options);

    // ── Pass 2: single 720p download — one request, no DASH section-seeking.
    // --download-sections on YouTube DASH is unreliable (seeks through the
    // segment index while merging streams live) and triggers rate-limiting
    // when run 3× in parallel from the same IP. One 720p download is
    // ~200–400 MB for a 30-min video vs 1+ GB for 1080p, and finishes
    // in 15–30 s on Railway's network.
    await setStatus('running', { step: 'downloading' });
    const videoPath = await downloadVideoForRender(url, workDir, cookiesPath);

    // Wrap in the sections shape cutAndCaptionClips expects (offset=0:
    // the full video starts at t=0 so clip.start/end are already correct).
    const sections = clipWindows.map((_, i) => ({ index: i + 1, path: videoPath, offset: 0 }));

    await setStatus('running', { step: 'cutting' });
    const clips = await cutAndCaptionClips(sections, clipWindows, workDir, transcript, options.faceCamBox || null);

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
  // Write cookies to temp file
  const cookiesPath = path.join(workDir, 'cookies.txt');
  if (process.env.YOUTUBE_COOKIES) {
    fs.writeFileSync(cookiesPath, process.env.YOUTUBE_COOKIES);
  }

  // Output template uses %(ext)s and we look the file up afterward, so the
  // container yt-dlp picks can never break the path. Note: when a video
  // exceeds --max-filesize, yt-dlp SKIPS the download and exits 0 — no
  // error, no file — so we inspect the log when nothing lands on disk.
  const cmd = [
    'yt-dlp',
    '--format', '"bestvideo[height<=1080]+bestaudio/best"',
    '--js-runtimes', 'node',
    '--merge-output-format', 'mp4',
    '--max-filesize', '1g',
    '--no-playlist',
    process.env.YOUTUBE_COOKIES ? `--cookies "${cookiesPath}"` : '',
    '--output', `"${path.join(workDir, 'source.%(ext)s')}"`,
    `"${url}"`,
  ].filter(Boolean).join(' ');

  const { stdout, stderr } = await execAsync(cmd, { timeout: 300_000 });

  const downloaded = fs.readdirSync(workDir).find(
    (f) => f.startsWith('source.') && !f.endsWith('.part')
  );

  if (!downloaded) {
    const log = `${stdout}\n${stderr}`;
    if (/max-filesize/i.test(log)) {
      throw new Error('Video exceeds the 1GB download limit — try a shorter or lower-resolution video');
    }
    throw new Error(`Download failed: ${log.trim().slice(-300) || 'output file not found'}`);
  }

  const outputPath = path.join(workDir, downloaded);

  const duration = getVideoDuration(outputPath);
  if (duration > MAX_VIDEO_DURATION_SECONDS) {
    throw new Error(`Video too long: ${Math.round(duration / 60)} minutes (max 60)`);
  }

  return outputPath;
}

function writeCookies(workDir) {
  if (!process.env.YOUTUBE_COOKIES) return null;
  const p = path.join(workDir, 'cookies.txt');
  fs.writeFileSync(p, process.env.YOUTUBE_COOKIES);
  return p;
}

// Single 720p video download for rendering. One reliable request is far
// better than 3 parallel --download-sections calls which hit YouTube DASH
// rate limits and fail ~50% of the time on shared Railway IPs.
async function downloadVideoForRender(url, workDir, cookiesPath) {
  const cmd = [
    'yt-dlp',
    '--format', '"bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=720]+bestaudio/best[height<=720]/best"',
    '--merge-output-format', 'mp4',
    '--no-playlist',
    '--js-runtimes', 'node',
    '--concurrent-fragments', '4',
    '--retries', '3',
    '--fragment-retries', '3',
    '--max-filesize', '1g',
    cookiesPath ? `--cookies "${cookiesPath}"` : '',
    '--output', `"${path.join(workDir, 'video.%(ext)s')}"`,
    `"${url}"`,
  ].filter(Boolean).join(' ');

  const { stdout, stderr } = await execAsync(cmd, { timeout: 300_000 });

  const downloaded = fs.readdirSync(workDir).find(
    (f) => f.startsWith('video.') && !f.endsWith('.part')
  );
  if (!downloaded) {
    const log = `${stdout}
${stderr}`;
    if (/max-filesize/i.test(log)) {
      throw new Error('Video exceeds the 1 GB size limit — try a shorter video');
    }
    throw new Error(`Video download failed: ${log.trim().slice(-300)}`);
  }

  const videoPath = path.join(workDir, downloaded);
  const duration  = getVideoDuration(videoPath);
  if (duration > MAX_VIDEO_DURATION_SECONDS) {
    throw new Error(`Video too long: ${Math.round(duration / 60)} min (max 60)`);
  }
  return videoPath;
}

// Audio-only download for transcription — much faster than a full video download.
async function downloadAudioOnly(url, workDir, cookiesPath) {
  const cmd = [
    'yt-dlp',
    '--format', '"bestaudio/best"',
    '--no-playlist',
    '--js-runtimes', 'node',
    '--concurrent-fragments', '4',
    '--retries', '3',
    '--fragment-retries', '3',
    cookiesPath ? `--cookies "${cookiesPath}"` : '',
    '--output', `"${path.join(workDir, 'audio.%(ext)s')}"`,
    `"${url}"`,
  ].filter(Boolean).join(' ');

  const { stdout, stderr } = await execAsync(cmd, { timeout: 180_000 });

  const downloaded = fs.readdirSync(workDir).find(
    (f) => f.startsWith('audio.') && !f.endsWith('.part')
  );
  if (!downloaded) {
    throw new Error(`Audio download failed: ${(stdout + stderr).trim().slice(-300)}`);
  }
  return path.join(workDir, downloaded);
}

// Download a specific time window of a video. We buffer 4 s on each side so
// keyframe alignment never clips the first/last frame; ffmpeg does the precise
// trim later. Returns { index, path, offset } where offset = actual file start.
async function downloadClipSection(url, clipStart, clipEnd, workDir, index, cookiesPath) {
  const bufStart = Math.max(0, clipStart - 4);
  const bufEnd   = clipEnd + 4;
  const outBase  = path.join(workDir, `section_${index}`);

  const cmd = [
    'yt-dlp',
    '--format', '"bestvideo[height<=1080]+bestaudio/best"',
    '--merge-output-format', 'mp4',
    '--no-playlist',
    '--js-runtimes', 'node',
    '--concurrent-fragments', '4',
    '--retries', '3',
    '--fragment-retries', '3',
    '--download-sections', `"*${bufStart}-${bufEnd}"`,
    cookiesPath ? `--cookies "${cookiesPath}"` : '',
    '--output', `"${outBase}.%(ext)s"`,
    `"${url}"`,
  ].filter(Boolean).join(' ');

  const { stdout, stderr } = await execAsync(cmd, { timeout: 180_000 });

  const downloaded = fs.readdirSync(workDir).find(
    (f) => f.startsWith(`section_${index}.`) && !f.endsWith('.part')
  );
  if (!downloaded) {
    throw new Error(`Section ${index} download failed: ${(stdout + stderr).trim().slice(-200)}`);
  }
  return { index, path: path.join(workDir, downloaded), offset: bufStart };
}

// Download all clip sections in parallel.
async function downloadClipSections(url, clipWindows, workDir, cookiesPath) {
  return Promise.all(
    clipWindows.map((clip, i) =>
      downloadClipSection(url, clip.start, clip.end, workDir, i + 1, cookiesPath)
    )
  );
}

function getVideoDuration(videoPath) {
  const result = execSync(
    `ffprobe -v error -show_entries format=duration -of csv=p=0 "${videoPath}"`
  ).toString().trim();
  return parseFloat(result);
}

function getVideoDims(videoPath) {
  const result = execSync(
    `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "${videoPath}"`
  ).toString().trim();
  const [w, h] = result.split(',').map(Number);
  if (!w || !h) throw new Error(`Could not read video dimensions: "${result}"`);
  return { w, h };
}

// ─── Step 2: Transcribe ───────────────────────────────────────────────────────

async function transcribeVideo(videoPath) {
  // Don't derive this from videoPath — the source may not be .mp4, and a
  // failed .replace() would make ffmpeg write over its own input file.
  const audioPath = path.join(path.dirname(videoPath), 'audio.mp3');
  // 32k mono is plenty for speech and keeps a 60-min video (~14MB) under
  // Whisper's 25MB upload cap. 64k overflows the cap at ~52 minutes.
  await execAsync(
    `ffmpeg -i "${videoPath}" -vn -ar 16000 -ac 1 -b:a 32k "${audioPath}" -y`
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
  formData.append('timestamp_granularities[]', 'word');

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
  const isLongForm = minDuration >= 120; // 2+ minutes = long-form mode

  const segmentText = transcript.segments
    .map((s) => `[${s.start.toFixed(1)}s → ${s.end.toFixed(1)}s] ${s.text}`)
    .join('\n');

  // The scoring criteria and persona differ significantly between short-form
  // (viral hooks, punchy) and long-form (complete narratives, digest).
  const persona = isLongForm
    ? 'You are an expert podcast and long-form video editor.'
    : 'You are an expert short-form video editor.';

  const formatDesc = isLongForm
    ? `long-form highlight clips (YouTube, podcasts, LinkedIn) — each a self-contained segment a viewer could watch on its own`
    : `viral short-form clips (TikTok, Reels, Shorts)`;

  const priorityCriteria = isLongForm
    ? `- Complete topic or argument with a clear beginning, middle, and end
- Full interview answers, explanations, or stories — never cut mid-thought
- Segments that stand alone without needing external context
- Natural breathing room at start and end (don't start mid-sentence)
- Aim to space clips across different parts of the video so together they cover the full content`
    : `- Strong hook in the first 3–5 seconds that creates immediate curiosity
- Surprising facts, emotional peaks, or high-value insight
- Complete thought that lands cleanly without trailing off`;

  const hookDimDesc = isLongForm
    ? 'Quality of the opening sentence — does it draw the viewer in for a longer watch?'
    : 'Strength of the opening 5 seconds. Does it create immediate curiosity or emotion?';

  const prompt = `${persona} Analyze this transcript and identify the ${maxClips} best clip windows for ${formatDesc}.

TRANSCRIPT WITH TIMESTAMPS:
${segmentText}

RULES:
- Each clip must be ${minDuration}–${maxDuration} seconds long
- ${priorityCriteria}
- Clips must start and end at natural speech boundaries (not mid-sentence)
- No overlapping clips

SCORING DIMENSIONS — grade each clip on all four:
  hook  : ${hookDimDesc}
  flow  : Pacing and narrative coherence. Does it feel complete and satisfying?
  value : Information density. Does it teach, entertain, or inspire something meaningful?
  trend : ${isLongForm ? 'Shareability and relevance. Would people send this to a friend?' : 'Viral/trend alignment. Does it touch a topic people are actively searching for?'}

Grade scale: A+, A, A-, B+, B, B-, C+, C, D, F

Respond ONLY with valid JSON in this exact format:
{
  "clips": [
    {
      "start": 12.5,
      "end": 47.2,
      "title": "${isLongForm ? 'Descriptive title for this segment' : 'Short punchy title for this clip'}",
      "hook": "First sentence that will appear as hook",
      "score": 95,
      "breakdown": {
        "hook":  { "grade": "A",  "reason": "One sentence explaining this grade." },
        "flow":  { "grade": "A-", "reason": "One sentence explaining this grade." },
        "value": { "grade": "A",  "reason": "One sentence explaining this grade." },
        "trend": { "grade": "B+", "reason": "One sentence explaining this grade." }
      }
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

// sections: [{ index, path, offset }, ...]
// Processes all clips in parallel — each renders independently on its own
// section file, so there is no shared state to serialize.
async function cutAndCaptionClips(sections, clipWindows, workDir, transcript, faceCamBox) {
  const faceCam = (faceCamBox && faceCamBox.w > 0 && faceCamBox.h > 0) ? faceCamBox : null;
  const dims = getVideoDims(sections[0].path);

  const results = await Promise.all(clipWindows.map(async (clip, i) => {
    const section    = sections[i];
    // The section file starts at section.offset; adjust seek times accordingly.
    // Clamp to 3 decimal places — JS float imprecision (e.g. 43.8999999999998)
    // doesn't cause ffmpeg errors but is ugly in logs and can confuse some demuxers.
    const ssTime = parseFloat(Math.max(0, clip.start - section.offset).toFixed(3));
    const toTime = parseFloat((clip.end   - section.offset).toFixed(3));
    const rawPath    = path.join(workDir, `raw_${section.index}.mp4`);
    const outputPath = path.join(workDir, `clip_${section.index}.mp4`);
    // Job-scoped ASS path so parallel jobs never collide in /tmp
    const assPath    = path.join(workDir, `sub_${section.index}.ass`);

    // Build ASS subtitle file — no path escaping issues, supports rich styling
    const layoutMode = faceCam ? 'facecam' : 'blur';
    const ass = buildASS(transcript, clip.start, clip.end, layoutMode, dims.w, dims.h);
    fs.writeFileSync(assPath, ass);

    // Pass 1: Cut and reformat to 9:16 (1080x1920)
    if (faceCam) {
      // UI box coords are in preview-frame space (video_w x video_h).
      // Scale them to the actual source resolution before cropping.
      const sx = faceCam.video_w ? dims.w / faceCam.video_w : 1;
      const sy = faceCam.video_h ? dims.h / faceCam.video_h : 1;
      const even = (n) => Math.max(2, 2 * Math.floor(n / 2));
      const cw = Math.min(even(faceCam.w * sx), even(dims.w));
      const ch = Math.min(even(faceCam.h * sy), even(dims.h));
      const cx = Math.min(Math.max(0, Math.round(faceCam.x * sx)), dims.w - cw);
      const cy = Math.min(Math.max(0, Math.round(faceCam.y * sy)), dims.h - ch);

      // Top: face cam crop, fill 1080x960 without distortion (scale to cover, center-crop).
      // Bottom: full frame fill 1080x960 the same way — no hardcoded source resolution,
      // no aspect squish.
      const vf = [
        `[0:v]split=2[a][b]`,
        `[a]crop=${cw}:${ch}:${cx}:${cy},scale=1080:960:force_original_aspect_ratio=increase,crop=1080:960[top]`,
        `[b]scale=1080:960:force_original_aspect_ratio=increase,crop=1080:960[bot]`,
        `[top][bot]vstack=inputs=2[v]`,
      ].join(';');
      await execAsync(
        `ffmpeg -ss ${ssTime} -to ${toTime} -i "${section.path}" -filter_complex "${vf}" -map "[v]" -map 0:a? -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k -movflags +faststart "${rawPath}" -y`,
        { timeout: 180_000 }
      );
    } else {
      // Blur background fill — fg must NOT be padded: pad fills with opaque
      // black and completely covers the blurred layer underneath (the
      // black-bars bug). Scale to fit, let overlay center it on the blur.
      const vf = [
        `[0:v]scale=1080:1920:force_original_aspect_ratio=decrease[fg]`,
        `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=20:5[bg]`,
        `[bg][fg]overlay=(W-w)/2:(H-h)/2[v]`,
      ].join(';');
      await execAsync(
        `ffmpeg -ss ${ssTime} -to ${toTime} -i "${section.path}" -filter_complex "${vf}" -map "[v]" -map 0:a? -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k -movflags +faststart "${rawPath}" -y`,
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

    // Extract thumbnail from the rendered 9:16 output at the midpoint.
    // Scale to 540px wide (half res) to keep R2 upload small.
    const thumbPath = path.join(workDir, `thumb_${section.index}.jpg`);
    const midSec = (clip.end - clip.start) * 0.45; // slightly before midpoint
    try {
      await execAsync(
        `ffmpeg -ss ${midSec} -i "${outputPath}" -vframes 1 -q:v 3 -vf "scale=540:-1" "${thumbPath}" -y`,
        { timeout: 15_000 }
      );
    } catch (_) { /* non-fatal — clip still usable without thumbnail */ }

    return {
      index: section.index,
      title: clip.title,
      hook: clip.hook,
      score: clip.score,
      start: clip.start,
      end: clip.end,
      duration: clip.end - clip.start,
      file: outputPath,
      thumbFile: fs.existsSync(thumbPath) ? thumbPath : null,
    };
  }));

  return results;
}

// ─── Step 5: Upload to R2 ─────────────────────────────────────────────────────

// S3/R2 metadata headers must be ASCII. GPT-4o titles often contain curly
// quotes or em-dashes, which makes PutObjectCommand throw and fails the job.
function asciiSafe(str) {
  return String(str || '').replace(/[^\x20-\x7E]/g, '').slice(0, 200);
}

async function uploadClipsToR2(clips, jobId, version = '') {
  const uploaded = [];

  for (const clip of clips) {
    const key = `clips/${jobId}/clip_${clip.index}${version ? `_${version}` : ''}.mp4`;
    const fileBuffer = fs.readFileSync(clip.file);

    await r2.send(new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      Body: fileBuffer,
      ContentType: 'video/mp4',
      Metadata: {
        jobId,
        title: asciiSafe(clip.title),
        score: String(clip.score),
      },
    }));

    const url = `${R2_PUBLIC_URL}/${key}`;

    // Upload thumbnail if the cut step produced one
    let thumbnail_url = null;
    if (clip.thumbFile && fs.existsSync(clip.thumbFile)) {
      const thumbKey = `clips/${jobId}/clip_${clip.index}${version ? `_${version}` : ''}_thumb.jpg`;
      await r2.send(new PutObjectCommand({
        Bucket: R2_BUCKET, Key: thumbKey,
        Body: fs.readFileSync(clip.thumbFile),
        ContentType: 'image/jpeg',
        Metadata: { jobId },
      }));
      thumbnail_url = `${R2_PUBLIC_URL}/${thumbKey}`;
    }

    uploaded.push({
      index: clip.index,
      title: clip.title,
      hook: clip.hook,
      score: clip.score,
      start: clip.start,
      end: clip.end,
      duration: clip.duration,
      url,
      thumbnail_url,
    });

    console.log(`[R2] Uploaded clip ${clip.index}: ${url}`);
  }

  return uploaded;
}

// ─── ASS subtitle builder ───────────────────────────────────────────────────────

// ─── ASS subtitle builder ─────────────────────────────────────────────────────
// Word-level karaoke: one Dialogue event per word showing the full display
// line, current word highlighted yellow, past/future words white.
// Falls back to segment-level subs when word timestamps are unavailable.

function buildASS(transcript, clipStart, clipEnd, layout = 'blur', srcW = 1920, srcH = 1080) {
  const words    = transcript.words    || [];
  const segments = transcript.segments || [];
  const marginV  = calcSubMarginV(layout, srcW, srcH);
  const header   = makeASSHeader(marginV);
  return words.length > 0
    ? header + buildKaraokeEvents(words, clipStart, clipEnd)
    : header + buildSegmentEvents(segments, clipStart, clipEnd);
}

// For blur mode, place subs 60px inside the video content area bottom edge,
// not floating in the blur zone below it.
function calcSubMarginV(layout, srcW, srcH) {
  if (layout === 'facecam') return 80;
  const srcAR    = srcW / srcH;
  const canvasAR = 1080 / 1920;      // 0.5625
  if (srcAR <= canvasAR) return 80;  // portrait/near-portrait fills full height
  // Landscape: content is width-limited at 1080px
  const contentH      = Math.round(1080 / srcAR);
  const contentBottom = Math.round((1920 + contentH) / 2); // px from top
  return Math.max(80, 1920 - contentBottom + 60);
}

const YELLOW = '&H0000FFFF&'; // ASS ABGR: opaque yellow (R=255,G=255,B=0)
const WHITE  = '&H00FFFFFF&'; // opaque white

function makeASSHeader(marginV) {
  return `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Liberation Sans,64,${WHITE},${YELLOW},&H00000000,&HCC000000,-1,0,0,0,100,100,0,0,1,4,0,2,80,80,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
}

function cleanWord(w) {
  return String(w || '').replace(/[{}]/g, '').replace(/\r?\n/g, ' ').trim();
}

// Group words into display lines (max 4 words / ~22 chars), then for each
// word emit a Dialogue event with the line text and that word highlighted.
function buildKaraokeEvents(rawWords, clipStart, clipEnd) {
  const words = rawWords
    .filter(w => w.end > clipStart && w.start < clipEnd)
    .map(w => ({
      word:  cleanWord(w.word),
      start: Math.max(0, w.start - clipStart),
      end:   Math.min(clipEnd - clipStart, w.end - clipStart),
    }))
    .filter(w => w.word.length > 0 && w.end > w.start);

  if (words.length === 0) return '';

  const lines = [];
  let cur = [];
  for (const w of words) {
    cur.push(w);
    if (cur.length >= 4 || cur.map(x => x.word).join(' ').length > 22) {
      lines.push(cur); cur = [];
    }
  }
  if (cur.length > 0) lines.push(cur);

  const events = [];
  for (const line of lines) {
    // Close micro-gaps between consecutive words within the line
    for (let i = 0; i < line.length - 1; i++) {
      if (line[i + 1].start > line[i].end) {
        line[i] = { ...line[i], end: line[i + 1].start };
      }
    }
    for (let i = 0; i < line.length; i++) {
      const lineText = line.map((w, j) =>
        j === i ? `{\\c${YELLOW}}${w.word}{\\c${WHITE}}` : w.word
      ).join(' ');
      events.push(
        `Dialogue: 0,${toASSTime(line[i].start)},${toASSTime(line[i].end)},Default,,0,0,0,,{\\c${WHITE}}${lineText}`
      );
    }
  }
  return events.join('\n') + '\n';
}

// Fallback: whole segment as a single line (no word timestamps)
function buildSegmentEvents(segments, clipStart, clipEnd) {
  return segments
    .filter(s => s.end > clipStart && s.start < clipEnd)
    .map(seg => {
      const s = Math.max(0, seg.start - clipStart);
      const e = Math.min(clipEnd - clipStart, seg.end - clipStart);
      return `Dialogue: 0,${toASSTime(s)},${toASSTime(e)},Default,,0,0,0,,${cleanWord(seg.text)}`;
    })
    .join('\n') + '\n';
}

function toASSTime(seconds) {
  // Compute in centiseconds so rounding can't produce ".100" (invalid)
  const totalCs = Math.max(0, Math.round(seconds * 100));
  const h = Math.floor(totalCs / 360000);
  const m = Math.floor((totalCs % 360000) / 6000);
  const s = Math.floor((totalCs % 6000) / 100);
  const cs = totalCs % 100;
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
  const keys = Array.from({ length: 5 }, (_, i) => [
    `clips/${jobId}/clip_${i + 1}.mp4`,
    `clips/${jobId}/clip_${i + 1}_thumb.jpg`,
  ]).flat();
  await Promise.allSettled(
    keys.map((key) => r2.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key })))
  );
}

// ─── Extend / trim a single clip ──────────────────────────────────────────────

const MAX_CLIP_SECONDS = 420; // 7-minute hard ceiling; long-form presets top out at 6 min

async function extendClip(jobId, clipIndex, newStart, newEnd, supabase) {
  const { data: job, error } = await supabase
    .from('jobs').select('*').eq('id', jobId).single();
  if (error || !job) throw new Error('Job not found');
  if (!job.segments) throw new Error('This job predates clip adjustment — re-run the video');
  // Normalise: old jobs stored segments array; new jobs store { segments, words }.
  const extTranscript = (job.segments && job.segments.words)
    ? job.segments
    : { segments: Array.isArray(job.segments) ? job.segments : [], words: [] };

  const clips = job.clips || [];
  const idx = clips.findIndex(c => c.index === clipIndex);
  if (idx === -1) throw new Error('Clip not found');

  const setClip = async (patch) => {
    clips[idx] = { ...clips[idx], ...patch };
    await supabase.from('jobs').update({ clips }).eq('id', jobId);
  };

  await setClip({ extending: true, extend_error: null });

  const workDir = path.join(TMP, `${jobId}-ext-${Date.now()}`);
  fs.mkdirSync(workDir, { recursive: true });

  try {
    const cookiesPath = writeCookies(workDir);

    let start = Math.max(0, newStart);
    let end   = newEnd;
    if (end - start < 5) throw new Error('Clip must be at least 5 seconds');
    if (end - start > MAX_CLIP_SECONDS) end = start + MAX_CLIP_SECONDS;

    // Section download: only fetch the adjusted window, not the entire video.
    // This is why extend re-renders are much faster than the original job.
    const section = await downloadClipSection(job.url, start, end, workDir, clipIndex, cookiesPath);

    const win = { ...clips[idx], start, end };
    const faceCamBox = (job.options && job.options.faceCamBox) || null;
    const cut = await cutAndCaptionClips([section], [win], workDir, extTranscript, faceCamBox);
    // cutAndCaptionClips assigns index by array position — restore the real one
    cut[0].index = clipIndex;

    const [uploaded] = await uploadClipsToR2(cut, jobId, `v${Date.now()}`);

    await setClip({ ...uploaded, extending: false, extend_error: null });
  } catch (err) {
    await setClip({ extending: false, extend_error: err.message });
    throw err;
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

module.exports = { processVideo, cleanupJob, deleteJobFromR2, extendClip };
