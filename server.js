"use strict";

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");

const {
  analyzeVoice
} = require("./voice-engine");

const {
  analyzeMovement
} = require("./movement-engine");

/* =====================================================
   APP
===================================================== */

const app = express();

app.use(cors());

app.use(
  express.json({
    limit: "10mb"
  })
);

/* =====================================================
   DIRECTORIES
===================================================== */

const uploadDir =
  path.join(
    os.tmpdir(),
    "ai-reel-uploads"
  );

const outputDir =
  path.join(
    os.tmpdir(),
    "ai-reel-outputs"
  );

fs.mkdirSync(
  uploadDir,
  {
    recursive: true
  }
);

fs.mkdirSync(
  outputDir,
  {
    recursive: true
  }
);

/* =====================================================
   MULTER
===================================================== */

const upload =
  multer({
    dest: uploadDir,

    limits: {
      fileSize:
        2 * 1024 * 1024 * 1024
    }
  });

/* =====================================================
   JOB STORAGE
===================================================== */

const jobs =
  new Map();

const voiceJobs =
  new Map();

const movementJobs =
  new Map();

/* =====================================================
   BASIC ROUTES
===================================================== */

app.get(
  "/",
  (req, res) => {
    res.json({
      ok: true,
      message:
        "AI Reel Backend is running."
    });
  }
);

app.get(
  "/health",
  (req, res) => {
    res.json({
      ok: true,
      service:
        "AI Reel Backend",
      cut:
        "ready",
      voice:
        "ready",
      movement:
        "ready"
    });
  }
);

/* =====================================================
   VIDEO DURATION
===================================================== */

function getVideoDuration(
  filePath
) {
  return new Promise(
    (resolve, reject) => {
      const ffprobe =
        spawn(
          "ffprobe",
          [
            "-v",
            "error",

            "-show_entries",
            "format=duration",

            "-of",
            "default=noprint_wrappers=1:nokey=1",

            filePath
          ]
        );

      let output = "";
      let errorOutput = "";

      ffprobe.stdout.on(
        "data",
        chunk => {
          output +=
            chunk.toString();
        }
      );

      ffprobe.stderr.on(
        "data",
        chunk => {
          errorOutput +=
            chunk.toString();
        }
      );

      ffprobe.on(
        "error",
        reject
      );

      ffprobe.on(
        "close",
        code => {
          if (code !== 0) {
            reject(
              new Error(
                errorOutput ||
                  "ffprobe failed."
              )
            );

            return;
          }

          const duration =
            Number(
              output.trim()
            );

          if (
            !Number.isFinite(
              duration
            )
          ) {
            reject(
              new Error(
                "Invalid video duration."
              )
            );

            return;
          }

          resolve(
            duration
          );
        }
      );
    }
  );
}

/* =====================================================
   START FFMPEG
   EXISTING MP4 CREATION
===================================================== */

function startFFmpeg(
  jobId,
  inputPath,
  outputPath,
  start
) {
  const args = [
    "-y",

    "-ss",
    String(start),

    "-i",
    inputPath,

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

    outputPath
  ];

  const ffmpeg =
    spawn(
      "ffmpeg",
      args
    );

  jobs.set(
    jobId,
    {
      status:
        "processing",

      progress: 0,

      outputPath,

      error: null,

      startedAt:
        Date.now()
    }
  );

  let stderr = "";

  ffmpeg.stderr.on(
    "data",
    chunk => {
      stderr +=
        chunk.toString();

      const job =
        jobs.get(jobId);

      if (!job) return;

      /*
      Keep progress alive.
      */

      job.progress =
        Math.min(
          99,
          job.progress + 1
        );
    }
  );

  ffmpeg.on(
    "error",
    error => {
      const job =
        jobs.get(jobId);

      if (!job) return;

      job.status =
        "error";

      job.error =
        error.message;
    }
  );

  ffmpeg.on(
    "close",
    code => {
      const job =
        jobs.get(jobId);

      if (!job) return;

      if (code === 0) {
        job.status =
          "ready";

        job.progress =
          100;

        job.error =
          null;
      } else {
        job.status =
          "error";

        job.error =
          stderr ||
          `FFmpeg exited with code ${code}`;
      }
    }
  );
}

/* =====================================================
   CUT API
===================================================== */

app.post(
  "/cut",
  upload.single("video"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          ok: false,
          error:
            "No video uploaded."
        });
      }

      let start =
        Number(
          req.body.start
        );

      if (
        !Number.isFinite(start)
      ) {
        start = 0;
      }

      start =
        Math.max(
          0,
          start
        );

      const jobId =
        crypto.randomUUID();

      const outputPath =
        path.join(
          outputDir,
          `${jobId}.mp4`
        );

      jobs.set(
        jobId,
        {
          status:
            "queued",

          progress: 0,

          outputPath,

          inputPath:
            req.file.path,

          error: null,

          startedAt:
            Date.now()
        }
      );

      startFFmpeg(
        jobId,
        req.file.path,
        outputPath,
        start
      );

      res.json({
        ok: true,
        jobId
      });

    } catch (error) {
      res.status(500).json({
        ok: false,
        error:
          error.message
      });
    }
  }
);

/* =====================================================
   CUT STATUS
===================================================== */

app.get(
  "/cut/status/:jobId",
  (req, res) => {
    const job =
      jobs.get(
        req.params.jobId
      );

    if (!job) {
      return res.status(404).json({
        ok: false,
        error:
          "Job not found."
      });
    }

    res.json({
      ok: true,
      status:
        job.status,

      progress:
        job.progress,

      error:
        job.error
    });
  }
);

/* =====================================================
   CUT DOWNLOAD
===================================================== */

app.get(
  "/cut/download/:jobId",
  (req, res) => {
    const job =
      jobs.get(
        req.params.jobId
      );

    if (!job) {
      return res.status(404).json({
        ok: false,
        error:
          "Job not found."
      });
    }

    if (
      job.status !==
      "ready"
    ) {
      return res.status(400).json({
        ok: false,
        error:
          "Video is not ready."
      });
    }

    if (
      !fs.existsSync(
        job.outputPath
      )
    ) {
      return res.status(404).json({
        ok: false,
        error:
          "Output file not found."
      });
    }

    res.download(
      job.outputPath,
      "AI_Reel_30Seconds_1080x1920.mp4"
    );
  }
);

/* =====================================================
   VOICE ANALYSIS
===================================================== */

app.post(
  "/voice/analyze",
  upload.single("video"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          ok: false,
          error:
            "No video uploaded."
        });
      }

      const duration =
        await getVideoDuration(
          req.file.path
        );

      const jobId =
        crypto.randomUUID();

      voiceJobs.set(
        jobId,
        {
          status:
            "queued",

          progress: 0,

          message:
            "Voice analysis queued.",

          inputPath:
            req.file.path,

          duration,

          result: null,

          error: null,

          startedAt:
            Date.now()
        }
      );

      runVoiceJob(
        jobId
      );

      res.json({
        ok: true,
        jobId,
        status:
          "queued",
        duration
      });

    } catch (error) {
      if (
        req.file &&
        req.file.path
      ) {
        cleanupVoiceFile(
          req.file.path
        );
      }

      res.status(500).json({
        ok: false,
        error:
          error.message
      });
    }
  }
);

/* =====================================================
   RUN VOICE JOB
===================================================== */

async function runVoiceJob(
  jobId
) {
  const job =
    voiceJobs.get(
      jobId
    );

  if (!job) return;

  try {
    job.status =
      "processing";

    job.message =
      "Running Voice Engine MAX...";

    const result =
      await analyzeVoice(
        job.inputPath,
        job.duration,
        progress => {
          const current =
            voiceJobs.get(
              jobId
            );

          if (!current) return;

          current.progress =
            Math.min(
              99,
              Number(
                progress
              ) || 0
            );
        }
      );

    job.status =
      "ready";

    job.progress =
      100;

    job.message =
      "Voice analysis complete.";

    job.result =
      result;

    cleanupVoiceFile(
      job.inputPath
    );

  } catch (error) {
    job.status =
      "error";

    job.progress =
      100;

    job.message =
      "Voice analysis failed.";

    job.error =
      error.message;

    cleanupVoiceFile(
      job.inputPath
    );
  }
}

/* =====================================================
   VOICE STATUS
===================================================== */

app.get(
  "/voice/status/:jobId",
  (req, res) => {
    const job =
      voiceJobs.get(
        req.params.jobId
      );

    if (!job) {
      return res.status(404).json({
        ok: false,
        error:
          "Voice job not found."
      });
    }

    res.json({
      ok: true,

      jobId:
        req.params.jobId,

      status:
        job.status,

      progress:
        job.progress,

      message:
        job.message,

      duration:
        job.duration,

      error:
        job.error,

      result:
        job.result
    });
  }
);

/* =====================================================
   VOICE CLEANUP
===================================================== */

function cleanupVoiceFile(
  filePath
) {
  try {
    if (
      filePath &&
      fs.existsSync(
        filePath
      )
    ) {
      fs.unlinkSync(
        filePath
      );
    }
  } catch {}
}

/* =====================================================
   MOVEMENT ANALYSIS
===================================================== */

app.post(
  "/movement/analyze",
  upload.single("video"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          ok: false,
          error:
            "No video uploaded."
        });
      }

      const duration =
        await getVideoDuration(
          req.file.path
        );

      const jobId =
        crypto.randomUUID();

      movementJobs.set(
        jobId,
        {
          status:
            "queued",

          progress: 0,

          message:
            "Movement analysis queued.",

          inputPath:
            req.file.path,

          duration,

          result: null,

          error: null,

          startedAt:
            Date.now()
        }
      );

      runMovementJob(
        jobId
      );

      res.json({
        ok: true,

        jobId,

        status:
          "queued",

        duration
      });

    } catch (error) {
      if (
        req.file &&
        req.file.path
      ) {
        cleanupMovementFile(
          req.file.path
        );
      }

      res.status(500).json({
        ok: false,
        error:
          error.message
      });
    }
  }
);

/* =====================================================
   RUN MOVEMENT JOB
===================================================== */

async function runMovementJob(
  jobId
) {
  const job =
    movementJobs.get(
      jobId
    );

  if (!job) return;

  try {
    job.status =
      "processing";

    job.message =
      "Running Movement Engine MAX...";

    const result =
      await analyzeMovement(
        job.inputPath,
        job.duration,
        progress => {
          const current =
            movementJobs.get(
              jobId
            );

          if (!current) return;

          current.progress =
            Math.min(
              99,
              Number(
                progress
              ) || 0
            );

          current.message =
            `Movement analysis ${current.progress}%`;
        }
      );

    job.status =
      "ready";

    job.progress =
      100;

    job.message =
      "Movement analysis complete.";

    job.result =
      result;

    cleanupMovementFile(
      job.inputPath
    );

  } catch (error) {
    job.status =
      "error";

    job.progress =
      100;

    job.message =
      "Movement analysis failed.";

    job.error =
      error.message;

    cleanupMovementFile(
      job.inputPath
    );
  }
}

/* =====================================================
   MOVEMENT STATUS
===================================================== */

app.get(
  "/movement/status/:jobId",
  (req, res) => {
    const job =
      movementJobs.get(
        req.params.jobId
      );

    if (!job) {
      return res.status(404).json({
        ok: false,
        error:
          "Movement job not found."
      });
    }

    res.json({
      ok: true,

      jobId:
        req.params.jobId,

      status:
        job.status,

      progress:
        job.progress,

      message:
        job.message,

      duration:
        job.duration,

      error:
        job.error,

      result:
        job.result
    });
  }
);

/* =====================================================
   MOVEMENT CLEANUP
===================================================== */

function cleanupMovementFile(
  filePath
) {
  try {
    if (
      filePath &&
      fs.existsSync(
        filePath
      )
    ) {
      fs.unlinkSync(
        filePath
      );
    }
  } catch {}
}

/* =====================================================
   CLEANUP OLD JOBS
===================================================== */

setInterval(
  () => {
    const now =
      Date.now();

    const maxAge =
      60 *
      60 *
      1000;

    for (
      const [
        jobId,
        job
      ] of jobs
    ) {
      if (
        now -
          job.startedAt >
        maxAge
      ) {
        try {
          if (
            job.outputPath &&
            fs.existsSync(
              job.outputPath
            )
          ) {
            fs.unlinkSync(
              job.outputPath
            );
          }
        } catch {}

        try {
          if (
            job.inputPath &&
            fs.existsSync(
              job.inputPath
            )
          ) {
            fs.unlinkSync(
              job.inputPath
            );
          }
        } catch {}

        jobs.delete(
          jobId
        );
      }
    }

    for (
      const [
        jobId,
        job
      ] of voiceJobs
    ) {
      if (
        now -
          job.startedAt >
        maxAge
      ) {
        cleanupVoiceFile(
          job.inputPath
        );

        voiceJobs.delete(
          jobId
        );
      }
    }

    for (
      const [
        jobId,
        job
      ] of movementJobs
    ) {
      if (
        now -
          job.startedAt >
        maxAge
      ) {
        cleanupMovementFile(
          job.inputPath
        );

        movementJobs.delete(
          jobId
        );
      }
    }
  },
  10 * 60 * 1000
);

/* =====================================================
   SERVER
===================================================== */

const PORT =
  process.env.PORT ||
  10000;

const server =
  app.listen(
    PORT,
    () => {
      console.log(
        `AI Reel Backend running on port ${PORT}`
      );

      console.log(
        "CUT ENGINE: READY"
      );

      console.log(
        "VOICE ENGINE: READY"
      );

      console.log(
        "MOVEMENT ENGINE MAX V2: READY"
      );
    }
  );

server.timeout =
  30 * 60 * 1000;

server.keepAliveTimeout =
  30 * 60 * 1000;

server.headersTimeout =
  30 * 60 * 1000;
