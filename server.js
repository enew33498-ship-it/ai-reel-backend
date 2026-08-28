const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

const app = express();

const PORT = process.env.PORT || 10000;

/*
==================================================
CORS
==================================================
*/

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Accept"],
  })
);

/*
==================================================
BODY
==================================================
*/

app.use(express.json());

/*
==================================================
UPLOAD
==================================================
*/

const upload = multer({
  dest: os.tmpdir(),

  limits: {
    fileSize: 5 * 1024 * 1024 * 1024,
  },
});

/*
==================================================
HEALTH CHECK
==================================================
*/

app.get("/", (req, res) => {
  console.log("[HEALTH] GET /");

  res.status(200).json({
    status: "ok",
    service: "AI Reel FFmpeg Backend",
    message: "Server is running",
    endpoint: "/cut",
    format: "9:16",
    speed: "original",
    audio: "original",
  });
});

/*
==================================================
FFMPEG PATH
==================================================
*/

function getFFmpegPath() {
  return process.env.FFMPEG_PATH || "ffmpeg";
}

/*
==================================================
NUMBER HELPER
==================================================
*/

function safeNumber(value, fallback) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return fallback;
  }

  return number;
}

/*
==================================================
CLEANUP
==================================================
*/

function cleanupFiles(inputPath, outputPath) {
  try {
    if (inputPath && fs.existsSync(inputPath)) {
      fs.unlinkSync(inputPath);

      console.log(
        "[CLEANUP] Deleted input:",
        inputPath
      );
    }
  } catch (error) {
    console.log(
      "[CLEANUP] Input error:",
      error.message
    );
  }

  try {
    if (outputPath && fs.existsSync(outputPath)) {
      fs.unlinkSync(outputPath);

      console.log(
        "[CLEANUP] Deleted output:",
        outputPath
      );
    }
  } catch (error) {
    console.log(
      "[CLEANUP] Output error:",
      error.message
    );
  }
}

/*
==================================================
CUT + 9:16 CONVERT
==================================================
*/

app.post(
  "/cut",
  upload.single("video"),
  async (req, res) => {
    let inputPath = null;
    let outputPath = null;

    try {
      console.log("");
      console.log(
        "=========================================="
      );
      console.log(
        "[CUT] NEW VIDEO REQUEST"
      );
      console.log(
        "=========================================="
      );

      /*
      ------------------------------------------
      CHECK FILE
      ------------------------------------------
      */

      if (!req.file) {
        console.log(
          "[CUT] ERROR: No video received"
        );

        return res.status(400).json({
          error: "No video file received.",
        });
      }

      inputPath = req.file.path;

      /*
      ------------------------------------------
      START
      ------------------------------------------
      */

      let start = safeNumber(
        req.body.start,
        0
      );

      if (start < 0) {
        start = 0;
      }

      /*
      ------------------------------------------
      DURATION
      ------------------------------------------
      */

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

      /*
      ------------------------------------------
      SAFETY LIMIT
      ------------------------------------------
      */

      if (duration < 1) {
        duration = 1;
      }

      if (duration > 600) {
        duration = 600;
      }

      duration = Math.round(
        duration * 1000
      ) / 1000;

      /*
      ------------------------------------------
      LOG
      ------------------------------------------
      */

      console.log(
        "[CUT] Original file:",
        req.file.originalname
      );

      console.log(
        "[CUT] Input:",
        inputPath
      );

      console.log(
        "[CUT] File size:",
        (
          req.file.size /
          1024 /
          1024
        ).toFixed(2),
        "MB"
      );

      console.log(
        "[CUT] Start:",
        start,
        "seconds"
      );

      console.log(
        "[CUT] Duration:",
        duration,
        "seconds"
      );

      console.log(
        "[CUT] Output ratio: 9:16"
      );

      console.log(
        "[CUT] Output resolution: 1080x1920"
      );

      console.log(
        "[CUT] Speed: ORIGINAL"
      );

      console.log(
        "[CUT] Audio: ORIGINAL"
      );

      /*
      ==========================================
      OUTPUT
      ==========================================
      */

      outputPath = path.join(
        os.tmpdir(),
        "AI_Reel_9x16_" +
          Date.now() +
          "_" +
          Math.random()
            .toString(36)
            .slice(2) +
          ".mp4"
      );

      const ffmpegPath =
        getFFmpegPath();

      console.log(
        "[CUT] FFmpeg:",
        ffmpegPath
      );

      console.log(
        "[CUT] Output:",
        outputPath
      );

      /*
      ==========================================
      FFMPEG
      ==========================================

      IMPORTANT:

      -ss
        Selected starting point

      -i
        Original video

      -t
        Selected duration

      scale
        Makes video large enough for 9:16

      crop
        Crops center into exact 9:16

      1080x1920
        Shorts/Reels resolution

      setsar=1
        Correct pixel aspect ratio

      IMPORTANT:
      No setpts.
      No atempo.
      No speed modification.

      Therefore:
      ORIGINAL SPEED.

      Audio is copied through AAC encoding
      without changing playback speed.
      ==========================================
      */

      const filter =

        "scale=" +
        "1080:1920:" +
        "force_original_aspect_ratio=increase," +

        "crop=" +
        "1080:1920," +

        "setsar=1";

      const args = [
        "-hide_banner",

        "-loglevel",
        "info",

        "-y",

        /*
        ----------------------------------------
        SEEK
        ----------------------------------------
        */

        "-ss",
        String(start),

        /*
        ----------------------------------------
        INPUT
        ----------------------------------------
        */

        "-i",
        inputPath,

        /*
        ----------------------------------------
        EXACT CLIP DURATION
        ----------------------------------------
        */

        "-t",
        String(duration),

        /*
        ----------------------------------------
        VIDEO FILTER
        ----------------------------------------
        */

        "-vf",
        filter,

        /*
        ----------------------------------------
        VIDEO
        ----------------------------------------
        */

        "-map",
        "0:v:0",

        /*
        ----------------------------------------
        AUDIO
        ----------------------------------------
        */

        "-map",
        "0:a:0?",

        /*
        ----------------------------------------
        VIDEO ENCODING
        ----------------------------------------
        */

        "-c:v",
        "libx264",

        "-preset",
        "veryfast",

        "-crf",
        "20",

        /*
        ----------------------------------------
        PIXEL FORMAT
        ----------------------------------------
        */

        "-pix_fmt",
        "yuv420p",

        /*
        ----------------------------------------
        AUDIO
        ----------------------------------------
        */

        "-c:a",
        "aac",

        "-b:a",
        "192k",

        /*
        ----------------------------------------
        MP4
        ----------------------------------------
        */

        "-movflags",
        "+faststart",

        /*
        ----------------------------------------
        TIMESTAMP SAFETY
        ----------------------------------------
        */

        "-avoid_negative_ts",
        "make_zero",

        /*
        ----------------------------------------
        OUTPUT
        ----------------------------------------
        */

        outputPath,
      ];

      console.log("");
      console.log(
        "[FFMPEG] Starting..."
      );

      console.log(
        "[FFMPEG] Command:"
      );

      console.log(
        ffmpegPath +
          " " +
          args.join(" ")
      );

      console.log("");

      /*
      ==========================================
      RUN FFMPEG
      ==========================================
      */

      await new Promise(
        (resolve, reject) => {
          const ffmpeg =
            spawn(
              ffmpegPath,
              args
            );

          let stderr = "";

          let stdout = "";

          /*
          --------------------------------------
          STDERR
          --------------------------------------
          */

          ffmpeg.stderr.on(
            "data",
            (data) => {
              const text =
                data.toString();

              stderr += text;

              /*
              Render logs
              */

              process.stdout.write(
                "[FFMPEG] " +
                  text
              );
            }
          );

          /*
          --------------------------------------
          STDOUT
          --------------------------------------
          */

          ffmpeg.stdout.on(
            "data",
            (data) => {
              const text =
                data.toString();

              stdout += text;

              process.stdout.write(
                "[FFMPEG-OUT] " +
                  text
              );
            }
          );

          /*
          --------------------------------------
          PROCESS ERROR
          --------------------------------------
          */

          ffmpeg.on(
            "error",
            (error) => {
              console.error(
                "[FFMPEG] PROCESS ERROR:"
              );

              console.error(
                error
              );

              reject(error);
            }
          );

          /*
          --------------------------------------
          PROCESS FINISHED
          --------------------------------------
          */

          ffmpeg.on(
            "close",
            (code) => {
              console.log("");

              console.log(
                "[FFMPEG] Finished."
              );

              console.log(
                "[FFMPEG] Exit code:",
                code
              );

              if (code === 0) {
                resolve();
              } else {
                reject(
                  new Error(
                    "FFmpeg exited with code " +
                      code +
                      "\n" +
                      stderr.slice(-8000)
                  )
                );
              }
            }
          );
        }
      );

      /*
      ==========================================
      CHECK OUTPUT
      ==========================================
      */

      if (
        !outputPath ||
        !fs.existsSync(outputPath)
      ) {
        throw new Error(
          "FFmpeg finished but MP4 was not created."
        );
      }

      const stats =
        fs.statSync(
          outputPath
        );

      if (
        !stats.size ||
        stats.size <= 0
      ) {
        throw new Error(
          "Output MP4 is empty."
        );
      }

      console.log(
        "[CUT] MP4 CREATED:"
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

      /*
      ==========================================
      SEND MP4
      ==========================================
      */

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

      /*
      ------------------------------------------
      EXTRA HEADERS
      ------------------------------------------
      */

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
        "X-Video-Speed",
        "original"
      );

      res.setHeader(
        "X-Video-Duration",
        String(duration)
      );

      /*
      ------------------------------------------
      STREAM
      ------------------------------------------
      */

      const stream =
        fs.createReadStream(
          outputPath
        );

      stream.on(
        "error",
        (error) => {
          console.error(
            "[STREAM] ERROR:",
            error
          );

          cleanupFiles(
            inputPath,
            outputPath
          );

          if (
            !res.headersSent
          ) {
            res.status(500).json({
              error:
                "Could not send video.",
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
            "[STREAM] MP4 completely sent."
          );
        }
      );

      stream.on(
        "close",
        () => {
          console.log(
            "[STREAM] Closing."
          );

          cleanupFiles(
            inputPath,
            outputPath
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
        "[CUT] VIDEO CREATION ERROR"
      );

      console.error(
        "=========================================="
      );

      console.error(
        error
      );

      console.error("");

      cleanupFiles(
        inputPath,
        outputPath
      );

      if (
        !res.headersSent
      ) {
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

/*
==================================================
MULTER / SERVER ERROR HANDLER
==================================================
*/

app.use(
  (
    err,
    req,
    res,
    next
  ) => {
    console.error(
      "[SERVER ERROR]"
    );

    console.error(
      err
    );

    if (
      !res.headersSent
    ) {
      res.status(500).json({
        error:
          "Server error",
        details:
          err.message,
      });
    }
  }
);

/*
==================================================
START SERVER
==================================================
*/

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log("");

    console.log(
      "=========================================="
    );

    console.log(
      "AI REEL BACKEND STARTED"
    );

    console.log(
      "=========================================="
    );

    console.log(
      "Port:",
      PORT
    );

    console.log(
      "Format: 9:16 Vertical"
    );

    console.log(
      "Resolution: 1080x1920"
    );

    console.log(
      "Speed: Original"
    );

    console.log(
      "Audio: Original"
    );

    console.log(
      "Endpoint: /cut"
    );

    console.log(
      "FFmpeg: Ready"
    );

    console.log(
      "=========================================="
    );

    console.log("");
  }
);
