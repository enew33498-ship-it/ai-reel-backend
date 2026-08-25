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
    allowedHeaders: ["Content-Type"],
  })
);

app.options("*", cors());

app.use(express.json());

/* ==================================================
   UPLOAD CONFIG
================================================== */

const uploadDir = path.join(os.tmpdir(), "ai-reel-uploads");

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, {
    recursive: true,
  });
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },

  filename: function (req, file, cb) {
    const safeName =
      Date.now() +
      "_" +
      Math.random()
        .toString(36)
        .substring(2, 10) +
      path.extname(file.originalname || ".mp4");

    cb(null, safeName);
  },
});

const upload = multer({
  storage: storage,

  limits: {
    fileSize: 5 * 1024 * 1024 * 1024,
  },
});

/* ==================================================
   HOME
================================================== */

app.get("/", (req, res) => {
  res.status(200).json({
    status: "ok",
    service: "AI Reel FFmpeg Backend",
    message: "Server is running",
    endpoint: "/cut",
  });
});

/* ==================================================
   HEALTH
================================================== */

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "healthy",
    ffmpeg: "checking",
  });
});

/* ==================================================
   FFmpeg PATH
================================================== */

function getFFmpegPath() {
  return process.env.FFMPEG_PATH || "ffmpeg";
}

/* ==================================================
   CLEANUP
================================================== */

function removeFile(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);

      console.log(
        "Deleted:",
        filePath
      );
    }
  } catch (error) {
    console.log(
      "Cleanup error:",
      error.message
    );
  }
}

/* ==================================================
   CUT VIDEO
================================================== */

app.post(
  "/cut",
  upload.single("video"),
  async (req, res) => {

    let inputPath = null;
    let outputPath = null;

    console.log("");
    console.log("======================================");
    console.log("POST /cut REQUEST RECEIVED");
    console.log("======================================");

    try {

      /* ------------------------------------------
         CHECK FILE
      ------------------------------------------ */

      if (!req.file) {

        console.log(
          "ERROR: No video file received"
        );

        return res.status(400).json({
          error: "No video file received.",
        });
      }

      inputPath =
        req.file.path;

      console.log(
        "Original name:",
        req.file.originalname
      );

      console.log(
        "Uploaded size:",
        req.file.size,
        "bytes"
      );

      console.log(
        "Temporary input:",
        inputPath
      );

      /* ------------------------------------------
         START TIME
      ------------------------------------------ */

      let start =
        Number(req.body.start);

      if (!Number.isFinite(start)) {
        start = 0;
      }

      if (start < 0) {
        start = 0;
      }

      console.log(
        "Requested start:",
        start,
        "seconds"
      );

      /* ------------------------------------------
         OUTPUT
      ------------------------------------------ */

      outputPath =
        path.join(
          os.tmpdir(),
          "AI_Reel_" +
            Date.now() +
            "_" +
            Math.random()
              .toString(36)
              .substring(2, 10) +
            ".mp4"
        );

      const ffmpegPath =
        getFFmpegPath();

      console.log(
        "FFmpeg path:",
        ffmpegPath
      );

      console.log(
        "Output:",
        outputPath
      );

      /* ------------------------------------------
         FFmpeg COMMAND
      ------------------------------------------ */

      const args = [

        "-hide_banner",

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

        "-c:v",
        "libx264",

        "-preset",
        "veryfast",

        "-crf",
        "18",

        "-c:a",
        "aac",

        "-b:a",
        "192k",

        "-movflags",
        "+faststart",

        "-avoid_negative_ts",
        "make_zero",

        outputPath,
      ];

      console.log("");
      console.log(
        "Starting FFmpeg..."
      );

      console.log(
        "Command arguments:",
        args
      );

      /* ------------------------------------------
         RUN FFMPEG
      ------------------------------------------ */

      await new Promise(
        (resolve, reject) => {

          const ffmpeg =
            spawn(
              ffmpegPath,
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
            (data) => {

              console.log(
                data.toString()
                  .trim()
              );

            }
          );

          ffmpeg.stderr.on(
            "data",
            (data) => {

              const text =
                data.toString();

              stderr += text;

              console.log(
                text.trim()
              );

            }
          );

          ffmpeg.on(
            "error",
            (error) => {

              console.error(
                "FFmpeg process error:",
                error
              );

              reject(error);

            }
          );

          ffmpeg.on(
            "close",
            (code) => {

              console.log(
                "FFmpeg finished.",
                "Exit code:",
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

      /* ------------------------------------------
         CHECK OUTPUT
      ------------------------------------------ */

      if (
        !fs.existsSync(
          outputPath
        )
      ) {

        throw new Error(
          "FFmpeg finished but MP4 was not created."
        );

      }

      const stats =
        fs.statSync(
          outputPath
        );

      console.log(
        "MP4 size:",
        stats.size,
        "bytes"
      );

      if (
        stats.size <= 0
      ) {

        throw new Error(
          "Created MP4 is empty."
        );

      }

      console.log("");
      console.log(
        "======================================"
      );

      console.log(
        "MP4 CREATED SUCCESSFULLY"
      );

      console.log(
        "======================================"
      );

      /* ------------------------------------------
         SEND MP4
      ------------------------------------------ */

      res.status(200);

      res.setHeader(
        "Content-Type",
        "video/mp4"
      );

      res.setHeader(
        "Content-Disposition",
        'attachment; filename="AI_Reel_Best_30_Seconds.mp4"'
      );

      res.setHeader(
        "Content-Length",
        stats.size
      );

      res.setHeader(
        "Cache-Control",
        "no-cache"
      );

      const stream =
        fs.createReadStream(
          outputPath
        );

      stream.on(
        "error",
        (error) => {

          console.error(
            "MP4 stream error:",
            error
          );

          removeFile(
            inputPath
          );

          removeFile(
            outputPath
          );

        }
      );

      stream.on(
        "end",
        () => {

          console.log("");
          console.log(
            "======================================"
          );

          console.log(
            "MP4 SENT TO CLIENT SUCCESSFULLY"
          );

          console.log(
            "======================================"
          );

          removeFile(
            inputPath
          );

          removeFile(
            outputPath
          );

        }
      );

      stream.pipe(res);

    } catch (error) {

      console.error("");
      console.error(
        "======================================"
      );

      console.error(
        "VIDEO CREATION ERROR"
      );

      console.error(
        error
      );

      console.error(
        "======================================"
      );

      removeFile(
        inputPath
      );

      removeFile(
        outputPath
      );

      if (
        !res.headersSent
      ) {

        res.status(500).json({
          error:
            "Video creation failed.",

          details:
            error.message ||
            "Unknown server error.",
        });

      }

    }

  }
);

/* ==================================================
   MULTER ERROR HANDLER
================================================== */

app.use(
  (error, req, res, next) => {

    console.error(
      "SERVER ERROR:",
      error
    );

    if (
      error instanceof multer.MulterError
    ) {

      return res.status(400).json({
        error:
          "Upload error",

        details:
          error.message,
      });

    }

    if (
      error
    ) {

      return res.status(500).json({
        error:
          "Server error",

        details:
          error.message,
      });

    }

    next();

  }
);

/* ==================================================
   START SERVER
================================================== */

app.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log("");
    console.log(
      "======================================"
    );

    console.log(
      "AI Reel backend running on port " +
      PORT
    );

    console.log(
      "CORS enabled"
    );

    console.log(
      "POST /cut ready"
    );

    console.log(
      "FFmpeg backend ready"
    );

    console.log(
      "======================================"
    );

  }
);
