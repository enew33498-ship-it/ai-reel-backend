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
   SETTINGS
============================================ */

app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Accept"]
}));

app.use(express.json({
  limit: "10mb"
}));

/* ============================================
   MULTER
============================================ */

const uploadDir = path.join(os.tmpdir(), "ai-reel-uploads");

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({

  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },

  filename: (req, file, cb) => {

    const safeName =
      Date.now() +
      "-" +
      Math.random()
        .toString(36)
        .substring(2, 10) +
      path.extname(file.originalname || ".mp4");

    cb(null, safeName);
  }

});

const upload = multer({

  storage,

  limits: {
    fileSize: 500 * 1024 * 1024
  }

});

/* ============================================
   HOME / HEALTH CHECK
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
   CUT VIDEO
============================================ */

app.post(
  "/cut",

  (req, res, next) => {

    upload.single("video")(req, res, function (err) {

      if (err) {

        console.error(
          "[UPLOAD ERROR]",
          err.message
        );

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

  async (req, res) => {

    console.log("\n================================");
    console.log("[CUT] NEW REQUEST");
    console.log("================================");

    let inputPath = null;
    let outputPath = null;

    try {

      if (!req.file) {

        return res.status(400).json({
          error: "No video uploaded"
        });

      }


      inputPath = req.file.path;


      const start =
        Number(req.body.start) || 0;


      const duration =
        Number(
          req.body.duration ||
          req.body.clipDuration
        ) || 30;


      if (
        !Number.isFinite(start) ||
        start < 0
      ) {

        return res.status(400).json({
          error: "Invalid start time"
        });

      }


      if (
        !Number.isFinite(duration) ||
        duration <= 0 ||
        duration > 600
      ) {

        return res.status(400).json({
          error: "Invalid duration"
        });

      }


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
        ).toFixed(2) + " MB"
      );


      console.log(
        "[START]",
        start
      );


      console.log(
        "[DURATION]",
        duration
      );


      outputPath =
        path.join(
          os.tmpdir(),

          "reel-" +
          Date.now() +
          "-" +
          Math.random()
            .toString(36)
            .substring(2, 10) +
          ".mp4"
        );


      /* ========================================
         FFMPEG
      ======================================== */

      const ffmpegArgs = [

        "-hide_banner",

        "-nostdin",

        "-y",

        "-ss",
        String(start),

        "-i",
        inputPath,

        "-t",
        String(duration),

        "-vf",

        "scale=1080:1920:force_original_aspect_ratio=increase:flags=lanczos,crop=1080:1920,setsar=1,format=yuv420p",

        "-map",
        "0:v:0",

        "-map",
        "0:a:0?",

        "-c:v",
        "libx264",

        "-preset",
        "veryfast",

        "-crf",
        "17",

        "-profile:v",
        "high",

        "-level:v",
        "4.2",

        "-pix_fmt",
        "yuv420p",

        "-movflags",
        "+faststart",

        "-c:a",
        "aac",

        "-b:a",
        "192k",

        "-ar",
        "48000",

        outputPath

      ];


      console.log(
        "[FFMPEG STARTING]"
      );


      console.log(
        "ffmpeg " +
        ffmpegArgs.join(" ")
      );


      await new Promise(
        (resolve, reject) => {

          const ffmpeg =
            spawn(
              "ffmpeg",
              ffmpegArgs
            );


          let stderr = "";


          ffmpeg.stdout.on(
            "data",
            data => {

              console.log(
                "[FFMPEG]",
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

              console.log(
                "[FFMPEG]",
                text
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

              if (code === 0) {

                resolve();

              } else {

                reject(
                  new Error(
                    "FFmpeg failed with code " +
                    code +
                    "\n" +
                    stderr.slice(-2000)
                  )
                );

              }

            }
          );

        }
      );


      /* ========================================
         CHECK OUTPUT
      ======================================== */

      if (
        !fs.existsSync(outputPath)
      ) {

        throw new Error(
          "Output MP4 was not created"
        );

      }


      const stats =
        fs.statSync(outputPath);


      if (
        !stats.size
      ) {

        throw new Error(
          "Output MP4 is empty"
        );

      }


      console.log(
        "[SUCCESS] MP4 CREATED"
      );


      console.log(
        "[OUTPUT SIZE]",
        (
          stats.size /
          1024 /
          1024
        ).toFixed(2) + " MB"
      );


      /* ========================================
         SEND VIDEO
      ======================================== */

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
        'attachment; filename="AI_Reel_1080x1920.mp4"'
      );


      const stream =
        fs.createReadStream(outputPath);


      stream.pipe(res);


      stream.on(
        "close",
        () => {

          cleanup();

        }
      );


      res.on(
        "finish",
        () => {

          console.log(
            "[RESPONSE] SENT SUCCESSFULLY"
          );

        }
      );


      function cleanup() {

        try {

          if (
            inputPath &&
            fs.existsSync(inputPath)
          ) {

            fs.unlinkSync(inputPath);

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

          }

        } catch (error) {

          console.log(
            "[CLEANUP OUTPUT ERROR]",
            error.message
          );

        }

      }


    } catch (error) {

      console.error(
        "\n[CUT ERROR]",
        error.message
      );


      try {

        if (
          inputPath &&
          fs.existsSync(inputPath)
        ) {

          fs.unlinkSync(inputPath);

        }

      } catch {}


      try {

        if (
          outputPath &&
          fs.existsSync(outputPath)
        ) {

          fs.unlinkSync(outputPath);

        }

      } catch {}


      if (!res.headersSent) {

        res.status(500).json({

          error:
            "MP4 creation failed",

          details:
            error.message

        });

      }

    }

  }

);


/* ============================================
   ERROR HANDLER
============================================ */

app.use(
  (err, req, res, next) => {

    console.error(
      "[SERVER ERROR]",
      err.message
    );


    if (
      res.headersSent
    ) {

      return next(err);

    }


    res.status(500).json({

      error:
        "Server error",

      details:
        err.message

    });

  }
);


/* ============================================
   START SERVER
============================================ */

const server =
  app.listen(
    PORT,
    "0.0.0.0",
    () => {

      console.log("================================");
      console.log("AI REEL STABLE BACKEND");
      console.log("================================");
      console.log("PORT:", PORT);
      console.log("OUTPUT: 1080x1920");
      console.log("RATIO: 9:16");
      console.log("QUALITY: HIGH");
      console.log("CRF: 17");
      console.log("PRESET: VERYFAST");
      console.log("UPLOAD LIMIT: 500 MB");
      console.log("================================");

    }
  );


/* ============================================
   LONG PROCESSING SUPPORT
============================================ */

server.timeout = 0;

server.requestTimeout = 0;

server.keepAliveTimeout = 120000;
