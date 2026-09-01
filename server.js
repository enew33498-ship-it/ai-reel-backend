const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

const app = express();

const PORT = process.env.PORT || 10000;

/* ==========================================
   CORS
========================================== */

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Accept"],
  })
);

app.use(express.json());

/* ==========================================
   UPLOAD
========================================== */

const upload = multer({
  dest: os.tmpdir(),
  limits: {
    fileSize: 5 * 1024 * 1024 * 1024,
  },
});

/* ==========================================
   HEALTH
========================================== */

app.get("/", (req, res) => {
  res.status(200).json({
    status: "ok",
    service: "AI Reel FFmpeg Backend",
    endpoint: "/cut",
    format: "9:16",
    resolution: "720x1280",
    speed: "original",
    audio: "original",
  });
});

/* ==========================================
   FFMPEG
========================================== */

function getFFmpegPath() {
  return process.env.FFMPEG_PATH || "ffmpeg";
}

/* ==========================================
   NUMBER
========================================== */

function safeNumber(value, fallback) {
  const n = Number(value);

  if (!Number.isFinite(n)) {
    return fallback;
  }

  return n;
}

/* ==========================================
   CLEANUP
========================================== */

function cleanup(file) {
  if (!file) return;

  try {
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
      console.log("[CLEANUP] Deleted:", file);
    }
  } catch (err) {
    console.log(
      "[CLEANUP] Error:",
      err.message
    );
  }
}

/* ==========================================
   CUT
========================================== */

app.post(
  "/cut",
  upload.single("video"),
  async (req, res) => {

    let inputPath = null;
    let outputPath = null;

    try {

      console.log("");
      console.log("================================");
      console.log("NEW /cut REQUEST");
      console.log("================================");

      /* FILE */

      if (!req.file) {
        return res.status(400).json({
          error: "No video file received.",
        });
      }

      inputPath = req.file.path;

      /* START */

      let start = safeNumber(
        req.body.start,
        0
      );

      if (start < 0) {
        start = 0;
      }

      /* DURATION */

      let duration = safeNumber(
        req.body.duration,
        NaN
      );

      if (!Number.isFinite(duration)) {
        duration = safeNumber(
          req.body.clipDuration,
          30
        );
      }

      duration = Math.max(
        1,
        Math.min(600, duration)
      );

      duration =
        Math.round(duration * 1000) / 1000;

      console.log(
        "[CUT] File:",
        req.file.originalname
      );

      console.log(
        "[CUT] Size:",
        (
          req.file.size /
          1024 /
          1024
        ).toFixed(2),
        "MB"
      );

      console.log(
        "[CUT] Start:",
        start
      );

      console.log(
        "[CUT] Duration:",
        duration
      );

      console.log(
        "[CUT] Output: 720x1280 9:16"
      );

      /* OUTPUT */

      outputPath = path.join(
        os.tmpdir(),
        "AI_REEL_" +
          Date.now() +
          "_" +
          Math.random()
            .toString(36)
            .slice(2) +
          ".mp4"
      );

      /* ======================================
         9:16 FILTER

         720x1280 is much lighter than
         1080x1920 for Render.
      ====================================== */

      const filter =
        "scale=720:1280:" +
        "force_original_aspect_ratio=increase," +
        "crop=720:1280," +
        "setsar=1";

      /* ======================================
         FFMPEG COMMAND
      ====================================== */

      const args = [

        "-hide_banner",

        "-loglevel",
        "warning",

        "-y",

        /* START */

        "-ss",
        String(start),

        /* INPUT */

        "-i",
        inputPath,

        /* EXACT DURATION */

        "-t",
        String(duration),

        /* VIDEO */

        "-vf",
        filter,

        "-map",
        "0:v:0",

        /* AUDIO */

        "-map",
        "0:a:0?",

        /* H264 */

        "-c:v",
        "libx264",

        "-preset",
        "ultrafast",

        "-crf",
        "23",

        "-pix_fmt",
        "yuv420p",

        /* AUDIO */

        "-c:a",
        "aac",

        "-b:a",
        "128k",

        /* MP4 */

        "-movflags",
        "+faststart",

        "-avoid_negative_ts",
        "make_zero",

        outputPath,
      ];

      console.log(
        "[FFMPEG] Starting..."
      );

      console.log(
        "[FFMPEG]",
        getFFmpegPath(),
        args.join(" ")
      );

      /* ======================================
         RUN FFMPEG
      ====================================== */

      await new Promise(
        (resolve, reject) => {

          const ffmpeg = spawn(
            getFFmpegPath(),
            args,
            {
              stdio: [
                "ignore",
                "pipe",
                "pipe",
              ],
            }
          );

          let stderr = "";

          ffmpeg.stdout.on(
            "data",
            data => {

              process.stdout.write(
                "[FFMPEG] " +
                data.toString()
              );

            }
          );

          ffmpeg.stderr.on(
            "data",
            data => {

              const text =
                data.toString();

              stderr += text;

              process.stdout.write(
                "[FFMPEG] " +
                text
              );

            }
          );

          ffmpeg.on(
            "error",
            error => {

              console.error(
                "[FFMPEG PROCESS ERROR]",
                error
              );

              reject(error);

            }
          );

          ffmpeg.on(
            "close",
            code => {

              console.log(
                "[FFMPEG] Exit code:",
                code
              );

              if (code === 0) {

                resolve();

              } else {

                reject(
                  new Error(
                    "FFmpeg failed with code " +
                    code +
                    "\n" +
                    stderr.slice(-6000)
                  )
                );

              }

            }
          );

        }
      );

      /* ======================================
         CHECK MP4
      ====================================== */

      if (
        !outputPath ||
        !fs.existsSync(outputPath)
      ) {

        throw new Error(
          "FFmpeg finished but MP4 was not created."
        );

      }

      const stats =
        fs.statSync(outputPath);

      if (stats.size <= 0) {

        throw new Error(
          "Generated MP4 is empty."
        );

      }

      console.log(
        "[CUT] MP4 CREATED"
      );

      console.log(
        "[CUT] Size:",
        (
          stats.size /
          1024 /
          1024
        ).toFixed(2),
        "MB"
      );

      /* ======================================
         RESPONSE HEADERS
      ====================================== */

      res.status(200);

      res.setHeader(
        "Content-Type",
        "video/mp4"
      );

      res.setHeader(
        "Content-Disposition",
        'attachment; filename="AI_Reel_9x16.mp4"'
      );

      res.setHeader(
        "Content-Length",
        stats.size
      );

      res.setHeader(
        "X-Video-Ratio",
        "9:16"
      );

      res.setHeader(
        "X-Video-Width",
        "720"
      );

      res.setHeader(
        "X-Video-Height",
        "1280"
      );

      res.setHeader(
        "X-Video-Speed",
        "original"
      );

      res.setHeader(
        "X-Video-Duration",
        String(duration)
      );

      /* ======================================
         STREAM MP4
      ====================================== */

      const stream =
        fs.createReadStream(
          outputPath
        );

      stream.on(
        "error",
        error => {

          console.error(
            "[STREAM ERROR]",
            error
          );

          cleanup(inputPath);
          cleanup(outputPath);

        }
      );

      stream.on(
        "end",
        () => {

          console.log(
            "[STREAM] MP4 sent successfully."
          );

        }
      );

      stream.on(
        "close",
        () => {

          console.log(
            "[STREAM] Stream closed."
          );

          cleanup(inputPath);
          cleanup(outputPath);

        }
      );

      stream.pipe(res);

    } catch (error) {

      console.error("");
      console.error(
        "================================"
      );
      console.error(
        "VIDEO CREATION ERROR"
      );
      console.error(
        "================================"
      );
      console.error(
        error.message
      );

      cleanup(inputPath);
      cleanup(outputPath);

      if (!res.headersSent) {

        res.status(500).json({
          error:
            "Video creation failed.",
          details:
            error.message,
        });

      }

    }

  }
);

/* ==========================================
   MULTER / SERVER ERRORS
========================================== */

app.use(
  (err, req, res, next) => {

    console.error(
      "[SERVER ERROR]",
      err
    );

    if (!res.headersSent) {

      res.status(500).json({
        error: "Server error",
        details: err.message,
      });

    }

  }
);

/* ==========================================
   START
========================================== */

app.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log("");
    console.log(
      "================================"
    );
    console.log(
      "AI REEL BACKEND STARTED"
    );
    console.log(
      "================================"
    );
    console.log(
      "Port:",
      PORT
    );
    console.log(
      "Format: 9:16"
    );
    console.log(
      "Resolution: 720x1280"
    );
    console.log(
      "Speed: ORIGINAL"
    );
    console.log(
      "Audio: ORIGINAL"
    );
    console.log(
      "Endpoint: /cut"
    );
    console.log(
      "FFmpeg: READY"
    );
    console.log(
      "================================"
    );

  }
);
