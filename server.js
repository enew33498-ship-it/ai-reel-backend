const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");

const app = express();

app.use(cors({ origin: "*" }));
app.use(express.json());

const PORT = process.env.PORT || 10000;

// ===============================
// UPLOAD SETTINGS
// ===============================

const uploadDir = path.join(os.tmpdir(), "ai-reel-uploads");
const outputDir = path.join(os.tmpdir(), "ai-reel-outputs");

fs.mkdirSync(uploadDir, { recursive: true });
fs.mkdirSync(outputDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },

  filename: (req, file, cb) => {
    const id = crypto.randomUUID();
    cb(null, id + path.extname(file.originalname || ".mp4"));
  }
});

const upload = multer({
  storage,

  limits: {
    fileSize: 2 * 1024 * 1024 * 1024
  }
});

// ===============================
// JOB STORAGE
// ===============================

const jobs = new Map();

// ===============================
// HOME
// ===============================

app.get("/", (req, res) => {
  res.send(`
    <h1>AI Reel Editor Backend</h1>
    <p>Server is online.</p>
    <p>Use /health to check status.</p>
  `);
});

// ===============================
// HEALTH
// ===============================

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "AI Reel Editor Backend",
    time: new Date().toISOString()
  });
});

// ===============================
// CREATE CUT JOB
// ===============================

app.post("/cut", upload.single("video"), (req, res) => {

  if (!req.file) {
    return res.status(400).json({
      ok: false,
      error: "No video uploaded."
    });
  }

  let start = Number(req.body.start || 0);
  let duration = Number(
    req.body.duration ||
    req.body.clipDuration ||
    30
  );

  if (!Number.isFinite(start) || start < 0) {
    start = 0;
  }

  if (!Number.isFinite(duration) || duration <= 0) {
    duration = 30;
  }

  // Exact 30 second mode
  duration = 30;

  const jobId = crypto.randomUUID();

  const inputPath = req.file.path;

  const outputPath = path.join(
    outputDir,
    `${jobId}.mp4`
  );

  jobs.set(jobId, {
    id: jobId,
    status: "processing",
    progress: 0,
    start,
    duration,
    inputPath,
    outputPath,
    createdAt: Date.now(),
    finishedAt: null,
    error: null
  });

  console.log("");
  console.log("======================================");
  console.log("[NEW CUT JOB]");
  console.log("[JOB ID]", jobId);
  console.log("[INPUT]", inputPath);
  console.log("[START]", start);
  console.log("[DURATION]", duration);
  console.log("======================================");

  startFFmpeg(jobId);

  // IMPORTANT:
  // Browser ko MP4 directly nahi bhej rahe.
  // Sirf job ID return kar rahe hain.
  res.json({
    ok: true,
    jobId,
    message: "Video processing started."
  });
});

// ===============================
// START FFMPEG
// ===============================

function startFFmpeg(jobId) {

  const job = jobs.get(jobId);

  if (!job) return;

  console.log("[FFMPEG] Starting job:", jobId);

  /*
    FAST + HIGH QUALITY SETTINGS

    ultrafast:
    Render Free CPU par kaafi faster.

    CRF 18:
    High quality.

    1080x1920:
    Reels / Shorts vertical output.

    bilinear:
    Lanczos se much faster.
  */

  const args = [
    "-y",

    "-ss",
    String(job.start),

    "-i",
    job.inputPath,

    "-t",
    "30",

    "-map",
    "0:v:0",

    "-map",
    "0:a:0?",

    "-vf",
    "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920",

    "-c:v",
    "libx264",

    "-preset",
    "ultrafast",

    "-crf",
    "18",

    "-pix_fmt",
    "yuv420p",

    "-r",
    "30",

    "-c:a",
    "aac",

    "-b:a",
    "192k",

    "-ar",
    "48000",

    "-ac",
    "2",

    "-movflags",
    "+faststart",

    job.outputPath
  ];

  console.log("[FFMPEG COMMAND]");
  console.log("ffmpeg " + args.join(" "));

  const ffmpeg = spawn("ffmpeg", args);

  job.ffmpeg = ffmpeg;

  let stderrData = "";

  ffmpeg.stderr.on("data", (data) => {

    const text = data.toString();

    stderrData += text;

    // FFmpeg time progress
    const match = text.match(
      /time=(\d+):(\d+):(\d+(?:\.\d+)?)/ 
    );

    if (match) {

      const hours = Number(match[1]);
      const minutes = Number(match[2]);
      const seconds = Number(match[3]);

      const current =
        hours * 3600 +
        minutes * 60 +
        seconds;

      let progress =
        Math.round((current / 30) * 100);

      progress = Math.max(
        0,
        Math.min(99, progress)
      );

      job.progress = progress;
    }
  });

  ffmpeg.on("error", (err) => {

    console.error("[FFMPEG ERROR]", err);

    job.status = "error";
    job.error = err.message;
    job.finishedAt = Date.now();

    cleanupInput(job);
  });

  ffmpeg.on("close", (code) => {

    console.log("");
    console.log("[FFMPEG FINISHED]");
    console.log("[JOB]", jobId);
    console.log("[EXIT CODE]", code);

    if (code !== 0) {

      job.status = "error";
      job.error =
        "FFmpeg failed with exit code " + code;

      console.error(
        "[FFMPEG FAILED]",
        stderrData.slice(-3000)
      );

      cleanupInput(job);

      return;
    }

    if (!fs.existsSync(job.outputPath)) {

      job.status = "error";
      job.error = "Output MP4 was not created.";

      cleanupInput(job);

      return;
    }

    const stats = fs.statSync(job.outputPath);

    console.log(
      "[OUTPUT SIZE]",
      (stats.size / 1024 / 1024).toFixed(2),
      "MB"
    );

    job.status = "ready";
    job.progress = 100;
    job.finishedAt = Date.now();

    console.log("[JOB READY]");
    console.log(
      "[DOWNLOAD]",
      `/cut/download/${jobId}`
    );

    // Input ab delete kar sakte hain.
    cleanupInput(job);

    // Safety cleanup:
    // agar user download na kare to 15 min baad output delete.
    setTimeout(() => {

      const currentJob = jobs.get(jobId);

      if (!currentJob) return;

      if (
        fs.existsSync(currentJob.outputPath)
      ) {

        try {
          fs.unlinkSync(
            currentJob.outputPath
          );

          console.log(
            "[AUTO CLEANUP]",
            jobId
          );

        } catch (e) {
          console.log(
            "[AUTO CLEANUP ERROR]",
            e.message
          );
        }
      }

      jobs.delete(jobId);

    }, 15 * 60 * 1000);
  });
}

// ===============================
// JOB STATUS
// ===============================

app.get("/cut/status/:jobId", (req, res) => {

  const job = jobs.get(req.params.jobId);

  if (!job) {

    return res.status(404).json({
      ok: false,
      error: "Job not found or expired."
    });
  }

  res.json({
    ok: true,

    jobId: job.id,

    status: job.status,

    progress: job.progress,

    duration: 30,

    error: job.error || null,

    downloadUrl:
      job.status === "ready"
        ? `/cut/download/${job.id}`
        : null
  });
});

// ===============================
// DIRECT MP4 DOWNLOAD
// ===============================

app.get("/cut/download/:jobId", (req, res) => {

  const job = jobs.get(req.params.jobId);

  if (!job) {

    return res.status(404).send(
      "Job not found or expired."
    );
  }

  if (job.status !== "ready") {

    return res.status(409).send(
      "Video is not ready yet."
    );
  }

  if (!fs.existsSync(job.outputPath)) {

    return res.status(404).send(
      "MP4 file no longer exists."
    );
  }

  console.log(
    "[DOWNLOAD REQUEST]",
    job.id
  );

  const filename =
    "AI_Reel_30Seconds_1080x1920.mp4";

  const stats =
    fs.statSync(job.outputPath);

  res.setHeader(
    "Content-Type",
    "video/mp4"
  );

  res.setHeader(
    "Content-Length",
    stats.size
  );

  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${filename}"`
  );

  const stream =
    fs.createReadStream(job.outputPath);

  stream.on("error", (err) => {

    console.error(
      "[DOWNLOAD ERROR]",
      err
    );
  });

  stream.on("close", () => {

    console.log(
      "[DOWNLOAD STREAM CLOSED]",
      job.id
    );

    // Delete after successful stream.
    setTimeout(() => {

      try {

        if (
          fs.existsSync(job.outputPath)
        ) {
          fs.unlinkSync(
            job.outputPath
          );

          console.log(
            "[OUTPUT DELETED]",
            job.id
          );
        }

        jobs.delete(job.id);

      } catch (e) {

        console.log(
          "[DELETE ERROR]",
          e.message
        );
      }

    }, 3000);
  });

  stream.pipe(res);
});

// ===============================
// CLEAN INPUT
// ===============================

function cleanupInput(job) {

  if (!job || !job.inputPath) {
    return;
  }

  try {

    if (
      fs.existsSync(job.inputPath)
    ) {

      fs.unlinkSync(
        job.inputPath
      );

      console.log(
        "[INPUT DELETED]",
        job.inputPath
      );
    }

  } catch (err) {

    console.log(
      "[INPUT DELETE ERROR]",
      err.message
    );
  }
}

// ===============================
// MULTER ERROR
// ===============================

app.use((err, req, res, next) => {

  console.error("[SERVER ERROR]", err);

  if (
    err instanceof multer.MulterError
  ) {

    return res.status(400).json({
      ok: false,
      error: err.message
    });
  }

  res.status(500).json({
    ok: false,
    error:
      err.message ||
      "Internal server error."
  });
});

// ===============================
// SERVER
// ===============================

const server =
  app.listen(PORT, () => {

    console.log("");
    console.log(
      "======================================"
    );

    console.log(
      "AI REEL BACKEND RUNNING"
    );

    console.log(
      "PORT:",
      PORT
    );

    console.log(
      "======================================"
    );
  });

// Long video processing ke liye timeout off
server.timeout = 0;
server.requestTimeout = 0;
server.keepAliveTimeout = 120000;
