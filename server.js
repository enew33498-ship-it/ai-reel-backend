const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

const app = express();

const PORT = process.env.PORT || 10000;

/* ==================================================
CORS
================================================== */

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Accept"],
  })
);

app.use(express.json());

/* ==================================================
UPLOAD
================================================== */

const upload = multer({
  dest: os.tmpdir(),
  limits: {
    fileSize: 5 * 1024 * 1024 * 1024,
  },
});

/* ==================================================
HEALTH
================================================== */

app.get("/", (req, res) => {
  res.status(200).json({
    status: "ok",
    service: "AI Reel FFmpeg Backend",
    endpoint: "/cut",
    format: "9:16",
    resolution: "1080x1920",
    quality: "high",
    speed: "original",
    audio: "original",
  });
});

/* ==================================================
FFMPEG
================================================== */

function getFFmpegPath() {
  return process.env.FFMPEG_PATH || "ffmpeg";
}

/* ==================================================
NUMBER
================================================== */

function safeNumber(value, fallback) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return fallback;
  }

  return number;
}

/* ==================================================
CLEANUP
================================================== */

function cleanup(file) {
  try {
    if (file && fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  } catch (error) {
    console.log("[CLEANUP]", error.message);
  }
}

/* ==================================================
CUT
================================================== */

app.post(
  "/cut",
  upload.single("video"),
  async (req, res) => {
    let inputPath = null;
    let outputPath = null;

    try {
      console.log("");
      console.log("==========================================");
      console.log("AI REEL — NEW REQUEST");
      console.log("==========================================");

      /* ------------------------------------------
      FILE
      ------------------------------------------ */

      if (!req.file) {
        return res.status(400).json({
          error: "No video file received.",
        });
      }

      inputPath = req.file.path;

      /* ------------------------------------------
      START
      ------------------------------------------ */

      let start = safeNumber(
        req.body.start,
        0
      );

      if (start < 0) {
        start = 0;
      }

      /* ------------------------------------------
      DURATION
      ------------------------------------------ */

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

      /* ------------------------------------------
      LOG
      ------------------------------------------ */

      console.log(
        "[INPUT]",
        req.file.originalname
      );

      console.log(
        "[SIZE]",
        (
          req.file.size /
          1024 /
          1024
        ).toFixed(2),
        "MB"
      );

      console.log(
        "[START]",
        start
      );

      console.log(
        "[DURATION]",
        duration
      );

      console.log(
        "[FORMAT] 9:16"
      );

      console.log(
        "[RESOLUTION] 1080x1920"
      );

      console.log(
        "[QUALITY] HIGH"
      );

      console.log(
        "[SPEED] ORIGINAL"
      );

      console.log(
        "[AUDIO] ORIGINAL"
      );

      /* ------------------------------------------
      OUTPUT
      ------------------------------------------ */

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

      /* ------------------------------------------
      9:16 FILTER
      ------------------------------------------

      Video ko 1080x1920 ke liye scale karega.

      Aspect ratio preserve hoga.

      Extra area center se crop hoga.

      ------------------------------------------ */

      const filter =
        "scale=1080:1920:" +
        "force_original_aspect_ratio=increase," +
        "crop=1080:1920:" +
        "(iw-1080)/2:" +
        "(ih-1920)/2," +
        "setsar=1";

      /* ------------------------------------------
      FFMPEG
      ------------------------------------------ */

      const args = [
        "-hide_banner",

        "-loglevel",
        "info",

        "-y",

        /* Accurate starting point */
        "-ss",
        String(start),

        /* Input */
        "-i",
        inputPath,

        /* Exact selected duration */
        "-t",
        String(duration),

        /* 9:16 */
        "-vf",
        filter,

        /* Video */
        "-map",
        "0:v:0",

        /* Audio if available */
        "-map",
        "0:a:0?",

        /* HIGH QUALITY H264 */
        "-c:v",
        "libx264",

        /*
        Medium preset = better quality
        than veryfast at same CRF
        */

        "-preset",
        "medium",

        /*
        Lower CRF = higher quality
        */

        "-crf",
        "18",

        /* H264 compatibility */
        "-profile:v",
        "high",

        "-level",
        "4.1",

        /* Full quality color format */
        "-pix_fmt",
        "yuv420p",

        /* Audio */
        "-c:a",
        "aac",

        "-b:a",
        "192k",

        "-ar",
        "48000",

        /* Keep normal playback speed */
        "-vsync",
        "cfr",

        /* MP4 optimization */
        "-movflags",
        "+faststart",

        "-avoid_negative_ts",
        "make_zero",

        /* Output */
        outputPath,
      ];

      console.log("");
      console.log("[FFMPEG] STARTING");
      console.log(
        getFFmpegPath() +
          " " +
          args.join(" ")
      );

      /* ------------------------------------------
      RUN FFMPEG
      ------------------------------------------ */

      await new Promise(
        (resolve, reject) => {
          const ffmpeg = spawn(
            getFFmpegPath(),
            args
          );

          let stderr = "";

          ffmpeg.stderr.on(
            "data",
            data => {
              const text =
                data.toString();

              stderr += text;

              process.stdout.write(
                "[FFMPEG] " + text
              );
            }
          );

          ffmpeg.stdout.on(
            "data",
            data => {
              process.stdout.write(
                "[FFMPEG-OUT] " +
                  data.toString()
              );
            }
          );

          ffmpeg.on(
            "error",
            error => {
              reject(error);
            }
          );

          ffmpeg.on(
            "close",
            code => {
              console.log("");
              console.log(
                "[FFMPEG] EXIT:",
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
                      stderr.slice(-10000)
                  )
                );
              }
            }
          );
        }
      );

      /* ------------------------------------------
      CHECK OUTPUT
      ------------------------------------------ */

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

      console.log("");
      console.log(
        "[SUCCESS] MP4 CREATED"
      );

      console.log(
        "[OUTPUT SIZE]",
        (
          stats.size /
          1024 /
          1024
        ).toFixed(2),
        "MB"
      );

      /* ------------------------------------------
      RESPONSE
      ------------------------------------------ */

      res.status(200);

      res.setHeader(
        "Content-Type",
        "video/mp4"
      );

      res.setHeader(
        "Content-Disposition",
        'attachment; filename="AI_Reel_9x16_HighQuality.mp4"'
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
        "1080"
      );

      res.setHeader(
        "X-Video-Height",
        "1920"
      );

      res.setHeader(
        "X-Video-Duration",
        String(duration)
      );

      res.setHeader(
        "X-Video-Speed",
        "original"
      );

      res.setHeader(
        "X-Video-Audio",
        "original"
      );

      res.setHeader(
        "X-Video-Quality",
        "high"
      );

      /* ------------------------------------------
      STREAM OUTPUT
      ------------------------------------------ */

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

          if (!res.headersSent) {
            res.status(500).json({
              error:
                "Could not send MP4.",
              details:
                error.message,
            });
          }
        }
      );

      stream.on(
        "end",
        () => {
          console.log(
            "[STREAM] MP4 SENT"
          );
        }
      );

      stream.on(
        "close",
        () => {
          cleanup(inputPath);
          cleanup(outputPath);

          console.log(
            "[CLEANUP] COMPLETE"
          );
        }
      );

      stream.pipe(res);

    } catch (error) {

      console.error("");
      console.error(
        "=========================================="
      );

      console.error(
        "[ERROR]",
        error.message
      );

      console.error(
        "=========================================="
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

/* ==================================================
ERROR HANDLER
================================================== */

app.use(
  (err, req, res, next) => {

    console.error(
      "[SERVER ERROR]",
      err
    );

    if (!res.headersSent) {
      res.status(500).json({
        error: "Server error",
        details:
          err.message,
      });
    }
  }
);

/* ==================================================
START
================================================== */

app.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log("");
    console.log(
      "=========================================="
    );
    console.log(
      "AI REEL BACKEND READY"
    );
    console.log(
      "=========================================="
    );

    console.log(
      "Port:",
      PORT
    );

    console.log(
      "Format: 9:16"
    );

    console.log(
      "Resolution: 1080x1920"
    );

    console.log(
      "Quality: HIGH"
    );

    console.log(
      "CRF: 18"
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
      "=========================================="
    );
  }
);
