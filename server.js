const express = require("express");
const multer = require("multer");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

const app = express();
const PORT = process.env.PORT || 10000;

/* ============================================
   CORS
============================================ */

app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Accept"]
}));

app.use(express.json({ limit: "10mb" }));

/* ============================================
   UPLOAD DIRECTORY
============================================ */

const uploadDir = path.join(os.tmpdir(), "ai-reel-uploads");

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

/* ============================================
   MULTER
============================================ */

const storage = multer.diskStorage({

  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },

  filename: function (req, file, cb) {

    const ext = path.extname(file.originalname || ".mp4");

    const filename =
      Date.now() +
      "-" +
      Math.random().toString(36).substring(2, 10) +
      ext;

    cb(null, filename);
  }

});

const upload = multer({

  storage: storage,

  limits: {
    fileSize: 500 * 1024 * 1024
  }

});

/* ============================================
   HEALTH
============================================ */

app.get("/", (req, res) => {

  res.status(200).json({
    status: "online",
    service: "AI Reel Backend",
    message: "Server is ready"
  });

});

app.get("/health", (req, res) => {

  res.status(200).json({
    status: "ok"
  });

});

/* ============================================
   CUT / CREATE REEL
============================================ */

app.post(
  "/cut",

  function (req, res, next) {

    upload.single("video")(req, res, function (err) {

      if (err) {

        console.error("[UPLOAD ERROR]", err.message);

        if (err instanceof multer.MulterError) {

          return res.status(400).json({
            error: "Upload failed",
            details: err.message
          });

        }

        return res.status(400).json({
          error: "Upload error",
          details: err.message
        });

      }

      next();

    });

  },

  async function (req, res) {

    console.log("");
    console.log("==========================================");
    console.log("       AI REEL MP4 CREATION START");
    console.log("==========================================");

    let inputPath = null;
    let outputPath = null;

    try {

      /* ======================================
         CHECK UPLOAD
      ====================================== */

      if (!req.file) {

        return res.status(400).json({
          error: "No video uploaded"
        });

      }

      inputPath = req.file.path;

      /* ======================================
         PARAMETERS
      ====================================== */

      let start = Number(req.body.start);

      if (!Number.isFinite(start)) {
        start = 0;
      }

      start = Math.max(0, start);

      let duration = Number(
        req.body.duration ||
        req.body.clipDuration ||
        30
      );

      if (!Number.isFinite(duration)) {
        duration = 30;
      }

      /* Force maximum 30 seconds for this version */

      duration = 30;

      /* ======================================
         LOG
      ====================================== */

      console.log("[VIDEO]", req.file.originalname);

      console.log(
        "[FILE SIZE]",
        (req.file.size / 1024 / 1024).toFixed(2),
        "MB"
      );

      console.log("[START]", start, "seconds");

      console.log("[DURATION]", duration, "seconds");

      console.log("[INPUT]", inputPath);

      /* ======================================
         OUTPUT
      ====================================== */

      outputPath = path.join(
        os.tmpdir(),
        "AI_REEL_" +
        Date.now() +
        "_" +
        Math.random().toString(36).substring(2, 8) +
        ".mp4"
      );

      console.log("[OUTPUT]", outputPath);

      /* ======================================
         FFMPEG
         
         SPEED OPTIMIZED
      ====================================== */

      const ffmpegArgs = [

        "-hide_banner",

        "-loglevel",
        "info",

        "-nostdin",

        "-y",

        /* Fast seeking */

        "-ss",
        String(start),

        "-i",
        inputPath,

        /* EXACT 30 SEC */

        "-t",
        "30",

        /* ==================================
           FAST 9:16 CONVERSION
        ================================== */

        "-vf",
        "scale=1080:1920:force_original_aspect_ratio=increase:flags=bilinear,crop=1080:1920,setsar=1,format=yuv420p",

        /* ==================================
           VIDEO
        ================================== */

        "-map",
        "0:v:0",

        "-c:v",
        "libx264",

        /*
          ULTRAFAST = MUCH FASTER ENCODING
        */

        "-preset",
        "ultrafast",

        /*
          Good quality / reasonable file size
        */

        "-crf",
        "20",

        "-profile:v",
        "high",

        "-level:v",
        "4.2",

        "-pix_fmt",
        "yuv420p",

        /* ==================================
           ORIGINAL SPEED
        ================================== */

        "-r",
        "30",

        /* ==================================
           AUDIO
        ================================== */

        "-map",
        "0:a:0?",

        "-c:a",
        "aac",

        "-b:a",
        "160k",

        "-ar",
        "48000",

        /* ==================================
           MP4
        ================================== */

        "-movflags",
        "+faststart",

        outputPath

      ];

      console.log("");
      console.log("[FFMPEG START]");
      console.log("ffmpeg " + ffmpegArgs.join(" "));
      console.log("");

      /* ======================================
         RUN FFMPEG
      ====================================== */

      await new Promise(function (resolve, reject) {

        const ffmpeg = spawn(
          "ffmpeg",
          ffmpegArgs
        );

        let stderr = "";

        ffmpeg.stdout.on(
          "data",
          function (data) {

            console.log(
              "[FFMPEG]",
              data.toString().trim()
            );

          }
        );

        ffmpeg.stderr.on(
          "data",
          function (data) {

            const text = data.toString();

            stderr += text;

            /*
              Keep Render logs readable
            */

            process.stdout.write(
              "[FFMPEG] " + text
            );

          }
        );

        ffmpeg.on(
          "error",
          function (error) {

            reject(error);

          }
        );

        ffmpeg.on(
          "close",
          function (code) {

            console.log("");
            console.log(
              "[FFMPEG EXIT CODE]",
              code
            );

            if (code === 0) {

              console.log(
                "[FFMPEG] FINISHED SUCCESSFULLY"
              );

              resolve();

            } else {

              reject(
                new Error(
                  "FFmpeg failed with code " +
                  code +
                  "\n" +
                  stderr.slice(-4000)
                )
              );

            }

          }
        );

      });

      /* ======================================
         CHECK OUTPUT
      ====================================== */

      console.log("");
      console.log("[CHECK] Checking generated MP4...");

      if (!fs.existsSync(outputPath)) {

        throw new Error(
          "FFmpeg finished but MP4 was not created."
        );

      }

      const stats = fs.statSync(outputPath);

      if (!stats.size) {

        throw new Error(
          "Generated MP4 is empty."
        );

      }

      console.log(
        "[OUTPUT SIZE]",
        (stats.size / 1024 / 1024).toFixed(2),
        "MB"
      );

      /* ======================================
         SEND MP4
      ====================================== */

      console.log(
        "[RESPONSE] Sending MP4 to browser..."
      );

      res.status(200);

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
        'attachment; filename="AI_Reel_Best_30_Seconds.mp4"'
      );

      res.setHeader(
        "Cache-Control",
        "no-store"
      );

      const stream =
        fs.createReadStream(outputPath);

      stream.pipe(res);

      stream.on(
        "error",
        function (error) {

          console.error(
            "[STREAM ERROR]",
            error.message
          );

          if (!res.headersSent) {

            res.status(500).json({
              error: "MP4 streaming failed",
              details: error.message
            });

          } else {

            res.destroy();

          }

        }
      );

      stream.on(
        "close",
        function () {

          console.log(
            "[RESPONSE] MP4 SENT / STREAM CLOSED"
          );

          cleanup();

        }
      );

    } catch (error) {

      console.error("");
      console.error(
        "=========================================="
      );
      console.error(
        "[CUT ERROR]"
      );
      console.error(
        error.message
      );
      console.error(
        "=========================================="
      );

      cleanup();

      if (!res.headersSent) {

        res.status(500).json({

          error: "MP4 creation failed",

          details: error.message

        });

      }

    }

    /* ========================================
       CLEANUP
    ======================================== */

    function cleanup() {

      try {

        if (
          inputPath &&
          fs.existsSync(inputPath)
        ) {

          fs.unlinkSync(inputPath);

          console.log(
            "[CLEANUP] Input deleted"
          );

        }

      } catch (error) {

        console.log(
          "[CLEANUP INPUT ERROR]",
          error.message
        );

      }

      try {

        if (
          outputPath &&
          fs.existsSync(outputPath)
        ) {

          fs.unlinkSync(outputPath);

          console.log(
            "[CLEANUP] Output deleted"
          );

        }

      } catch (error) {

        console.log(
          "[CLEANUP OUTPUT ERROR]",
          error.message
        );

      }

    }

  }
);

/* ============================================
   GLOBAL ERROR HANDLER
============================================ */

app.use(
  function (err, req, res, next) {

    console.error(
      "[SERVER ERROR]",
      err.message
    );

    if (res.headersSent) {

      return next(err);

    }

    res.status(500).json({

      error: "Server error",

      details: err.message

    });

  }
);

/* ============================================
   START SERVER
============================================ */

const server = app.listen(
  PORT,
  "0.0.0.0",
  function () {

    console.log("");
    console.log("==========================================");
    console.log("       AI REEL FAST BACKEND");
    console.log("==========================================");
    console.log("PORT:", PORT);
    console.log("OUTPUT: 1080x1920");
    console.log("RATIO: 9:16");
    console.log("DURATION: EXACT 30 SEC");
    console.log("AUDIO: ORIGINAL AUDIO");
    console.log("SPEED: ORIGINAL SPEED");
    console.log("VIDEO: H.264");
    console.log("PRESET: ULTRAFAST");
    console.log("CRF: 20");
    console.log("UPLOAD LIMIT: 500 MB");
    console.log("==========================================");
    console.log("");

  }
);

/* ============================================
   LONG REQUEST SUPPORT
============================================ */

server.timeout = 0;

server.requestTimeout = 0;

server.headersTimeout = 0;

server.keepAliveTimeout = 120000;

/* ============================================
   PROCESS SAFETY
============================================ */

process.on(
  "uncaughtException",
  function (error) {

    console.error(
      "[UNCAUGHT EXCEPTION]",
      error
    );

  }
);

process.on(
  "unhandledRejection",
  function (error) {

    console.error(
      "[UNHANDLED REJECTION]",
      error
    );

  }
);
