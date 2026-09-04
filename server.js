const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

const app = express();

const PORT = process.env.PORT || 10000;

/* ================================================
   CORS
================================================ */

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Accept"],
  })
);

app.use(express.json());

/* ================================================
   UPLOAD
================================================ */

const upload = multer({
  dest: os.tmpdir(),

  limits: {
    fileSize: 5 * 1024 * 1024 * 1024,
  },
});

/* ================================================
   HEALTH CHECK
================================================ */

app.get("/", (req, res) => {
  res.status(200).json({
    status: "ok",
    service: "AI Reel Optimized Backend",
    endpoint: "/cut",
    output: "1080x1920",
    ratio: "9:16",
    quality: "optimized-high",
    speed: "original",
    audio: "original",
  });
});

/* ================================================
   HELPERS
================================================ */

function safeNumber(value, fallback) {
  const number = Number(value);

  return Number.isFinite(number)
    ? number
    : fallback;
}

function cleanup(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log("[CLEANUP] Deleted:", filePath);
    }
  } catch (error) {
    console.log("[CLEANUP ERROR]", error.message);
  }
}

function getFFmpegPath() {
  return process.env.FFMPEG_PATH || "ffmpeg";
}

/* ================================================
   VIDEO CUT API
================================================ */

app.post(
  "/cut",
  upload.single("video"),

  async (req, res) => {
    let inputPath = null;
    let outputPath = null;

    try {
      console.log("");
      console.log("================================");
      console.log("[CUT] NEW REQUEST");
      console.log("================================");

      /* --------------------------------------------
         CHECK VIDEO
      -------------------------------------------- */

      if (!req.file) {
        return res.status(400).json({
          error: "No video received.",
        });
      }

      inputPath = req.file.path;

      /* --------------------------------------------
         START
      -------------------------------------------- */

      let start = safeNumber(
        req.body.start,
        0
      );

      if (start < 0) {
        start = 0;
      }

      /* --------------------------------------------
         DURATION
      -------------------------------------------- */

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

      /* --------------------------------------------
         LOG
      -------------------------------------------- */

      console.log("[INPUT]", req.file.originalname);

      console.log(
        "[SIZE]",
        (req.file.size / 1024 / 1024).toFixed(2),
        "MB"
      );

      console.log("[START]", start);

      console.log("[DURATION]", duration);

      /* --------------------------------------------
         OUTPUT FILE
      -------------------------------------------- */

      outputPath = path.join(
        os.tmpdir(),
        "reel_" +
          Date.now() +
          "_" +
          Math.random()
            .toString(36)
            .slice(2) +
          ".mp4"
      );

      /* ============================================
         FAST HIGH QUALITY FILTER

         Lanczos removed because it is CPU-heavy.

         Bicubic gives good quality while being
         significantly faster on Render.
      ============================================ */

      const videoFilter =
        "scale=1080:1920:" +
        "force_original_aspect_ratio=increase:" +
        "flags=bicubic," +
        "crop=1080:1920," +
        "setsar=1," +
        "format=yuv420p";

      /* ============================================
         FFMPEG

         OPTIMIZED FOR RENDER

         -ss before input = faster seeking
         veryfast preset = much faster encoding
         CRF 20 = good quality + faster processing
         1080x1920 remains unchanged
         No speed changes
      ============================================ */

      const args = [
        "-hide_banner",

        "-loglevel",
        "error",

        "-y",

        /* FAST SEEK */

        "-ss",
        String(start),

        /* INPUT */

        "-i",
        inputPath,

        /* DURATION */

        "-t",
        String(duration),

        /* VIDEO FILTER */

        "-vf",
        videoFilter,

        /* MAP VIDEO */

        "-map",
        "0:v:0",

        /* MAP AUDIO IF AVAILABLE */

        "-map",
        "0:a:0?",

        /* VIDEO CODEC */

        "-c:v",
        "libx264",

        /* IMPORTANT: FAST */

        "-preset",
        "veryfast",

        /* GOOD QUALITY */

        "-crf",
        "20",

        /* COMPATIBILITY */

        "-pix_fmt",
        "yuv420p",

        /* PREVENT EXCESSIVE CPU SETTINGS */

        "-threads",
        "0",

        /* AUDIO */

        "-c:a",
        "aac",

        "-b:a",
        "160k",

        /* ORIGINAL AUDIO TIMING */

        "-ar",
        "44100",

        /* FASTSTART */

        "-movflags",
        "+faststart",

        /* OUTPUT */

        outputPath,
      ];

      const ffmpegPath = getFFmpegPath();

      console.log("");
      console.log("[FFMPEG STARTING]");
      console.log(
        ffmpegPath + " " + args.join(" ")
      );

      /* ============================================
         RUN FFMPEG
      ============================================ */

      await new Promise((resolve, reject) => {
        const ffmpeg = spawn(
          ffmpegPath,
          args
        );

        let errorOutput = "";

        ffmpeg.stderr.on(
          "data",
          (data) => {
            const text = data.toString();

            errorOutput += text;

            console.log("[FFMPEG]", text);
          }
        );

        ffmpeg.on(
          "error",
          (error) => {
            reject(error);
          }
        );

        ffmpeg.on(
          "close",
          (code) => {
            console.log(
              "[FFMPEG EXIT CODE]",
              code
            );

            if (code === 0) {
              resolve();
            } else {
              reject(
                new Error(
                  "FFmpeg failed.\n" +
                    errorOutput.slice(-5000)
                )
              );
            }
          }
        );
      });

      /* ============================================
         CHECK OUTPUT
      ============================================ */

      if (!fs.existsSync(outputPath)) {
        throw new Error(
          "MP4 output was not created."
        );
      }

      const stats = fs.statSync(outputPath);

      if (stats.size <= 0) {
        throw new Error(
          "Generated MP4 is empty."
        );
      }

      console.log("");
      console.log("================================");
      console.log("[SUCCESS] MP4 CREATED");
      console.log("================================");

      console.log(
        "[OUTPUT SIZE]",
        (stats.size / 1024 / 1024).toFixed(2),
        "MB"
      );

      console.log("[OUTPUT] 1080x1920");
      console.log("[RATIO] 9:16");
      console.log("[QUALITY] OPTIMIZED HIGH");
      console.log("[SPEED] ORIGINAL");
      console.log("[AUDIO] ORIGINAL");

      /* ============================================
         SEND VIDEO
      ============================================ */

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
        "X-Video-Width",
        "1080"
      );

      res.setHeader(
        "X-Video-Height",
        "1920"
      );

      res.setHeader(
        "X-Video-Ratio",
        "9:16"
      );

      res.setHeader(
        "X-Video-Speed",
        "original"
      );

      res.setHeader(
        "X-Video-Audio",
        "original"
      );

      const stream = fs.createReadStream(
        outputPath
      );

      stream.on("error", (error) => {
        console.error(
          "[STREAM ERROR]",
          error.message
        );

        cleanup(inputPath);
        cleanup(outputPath);

        if (!res.headersSent) {
          res.status(500).json({
            error: "Could not send MP4.",
          });
        }
      });

      /* Cleanup after response finishes */

      res.on("finish", () => {
        console.log(
          "[RESPONSE] MP4 sent successfully"
        );

        cleanup(inputPath);
        cleanup(outputPath);
      });

      stream.pipe(res);

    } catch (error) {

      console.error("");
      console.error("================================");
      console.error("[CUT ERROR]");
      console.error("================================");
      console.error(error);

      cleanup(inputPath);
      cleanup(outputPath);

      if (!res.headersSent) {
        res.status(500).json({
          error: "Video creation failed.",
          details: error.message,
        });
      }
    }
  }
);

/* ================================================
   ERROR HANDLER
================================================ */

app.use((err, req, res, next) => {
  console.error("[SERVER ERROR]", err);

  if (!res.headersSent) {
    res.status(500).json({
      error: "Server error.",
      details: err.message,
    });
  }
});

/* ================================================
   START SERVER
================================================ */

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log("");
    console.log("================================");
    console.log("AI REEL OPTIMIZED BACKEND");
    console.log("================================");
    console.log("PORT:", PORT);
    console.log("OUTPUT: 1080x1920");
    console.log("RATIO: 9:16");
    console.log("QUALITY: OPTIMIZED HIGH");
    console.log("VIDEO SPEED: ORIGINAL");
    console.log("AUDIO: ORIGINAL");
    console.log("CRF: 20");
    console.log("PRESET: VERYFAST");
    console.log("================================");
    console.log("");
  }
);
