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
    allowedHeaders: ["Content-Type"],
  })
);

/*
IMPORTANT:
Do NOT use app.options("*", cors()) here.
That wildcard can crash Express 5.
The cors middleware above already handles OPTIONS.
*/

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
HOME / HEALTH CHECK
==================================================
*/

app.get("/", (req, res) => {
  res.status(200).json({
    status: "ok",
    service: "AI Reel FFmpeg Backend",
    message: "Server is running",
    endpoint: "/cut",
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
CUT VIDEO
==================================================
*/

app.post("/cut", upload.single("video"), async (req, res) => {
  let inputPath = null;
  let outputPath = null;

  try {
    console.log("=================================");
    console.log("CUT REQUEST RECEIVED");
    console.log("=================================");

    if (!req.file) {
      console.log("ERROR: No video received");

      return res.status(400).json({
        error: "No video file received.",
      });
    }

    inputPath = req.file.path;

    let start = Number(req.body.start);

    if (!Number.isFinite(start)) {
      start = 0;
    }

    if (start < 0) {
      start = 0;
    }

    console.log("Original file:", req.file.originalname);
    console.log("Temporary input:", inputPath);
    console.log("Start time:", start);

    /*
    ==============================================
    OUTPUT FILE
    ==============================================
    */

    outputPath = path.join(
      os.tmpdir(),
      "AI_Reel_" +
        Date.now() +
        "_" +
        Math.random().toString(36).slice(2) +
        ".mp4"
    );

    const ffmpegPath = getFFmpegPath();

    console.log("FFmpeg path:", ffmpegPath);
    console.log("Output:", outputPath);

    /*
    ==============================================
    FFMPEG
    ==============================================

    -ss             Start position
    -i              Input video
    -t 30           Exactly 30 seconds
    -map video      Include video
    -map audio      Include audio if available
    -c:v libx264    MP4 video
    -preset         Faster encoding
    -crf 18         High quality
    -c:a aac        MP4 audio
    ==============================================
    */

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

    console.log("Starting FFmpeg...");

    await new Promise((resolve, reject) => {
      const ffmpeg = spawn(ffmpegPath, args);

      let stderr = "";

      ffmpeg.stderr.on("data", (data) => {
        const text = data.toString();

        stderr += text;

        console.log(text.trim());
      });

      ffmpeg.on("error", (error) => {
        console.error("FFmpeg PROCESS ERROR:");
        console.error(error);

        reject(error);
      });

      ffmpeg.on("close", (code) => {
        console.log("FFmpeg finished with code:", code);

        if (code === 0) {
          resolve();
        } else {
          reject(
            new Error(
              "FFmpeg exited with code " +
                code +
                "\n" +
                stderr.slice(-5000)
            )
          );
        }
      });
    });

    /*
    ==============================================
    CHECK OUTPUT
    ==============================================
    */

    if (!fs.existsSync(outputPath)) {
      throw new Error(
        "FFmpeg finished but MP4 was not created."
      );
    }

    const stats = fs.statSync(outputPath);

    if (stats.size <= 0) {
      throw new Error(
        "Output MP4 is empty."
      );
    }

    console.log(
      "MP4 CREATED:",
      stats.size,
      "bytes"
    );

    /*
    ==============================================
    SEND MP4
    ==============================================
    */

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

    const stream = fs.createReadStream(outputPath);

    stream.on("error", (error) => {
      console.error(
        "OUTPUT STREAM ERROR:",
        error
      );

      cleanupFiles(
        inputPath,
        outputPath
      );

      if (!res.headersSent) {
        res.status(500).json({
          error: "Could not send video.",
          details: error.message,
        });
      }
    });

    stream.on("close", () => {
      console.log(
        "MP4 SENT TO CLIENT"
      );

      cleanupFiles(
        inputPath,
        outputPath
      );
    });

    stream.pipe(res);

  } catch (error) {
    console.error(
      "================================="
    );

    console.error(
      "VIDEO CREATION ERROR:"
    );

    console.error(
      error
    );

    console.error(
      "================================="
    );

    cleanupFiles(
      inputPath,
      outputPath
    );

    if (!res.headersSent) {
      res.status(500).json({
        error: "Video creation failed.",
        details: error.message,
      });
    }
  }
});

/*
==================================================
CLEANUP
==================================================
*/

function cleanupFiles(inputPath, outputPath) {
  try {
    if (
      inputPath &&
      fs.existsSync(inputPath)
    ) {
      fs.unlinkSync(inputPath);

      console.log(
        "Deleted input temporary file."
      );
    }
  } catch (error) {
    console.log(
      "Input cleanup error:",
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
        "Deleted output temporary file."
      );
    }
  } catch (error) {
    console.log(
      "Output cleanup error:",
      error.message
    );
  }
}

/*
==================================================
ERROR HANDLER
==================================================
*/

app.use((err, req, res, next) => {
  console.error(
    "SERVER ERROR:",
    err
  );

  if (!res.headersSent) {
    res.status(500).json({
      error: "Server error",
      details: err.message,
    });
  }
});

/*
==================================================
START SERVER
==================================================
*/

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      "================================="
    );

    console.log(
      "AI Reel backend running on port " +
        PORT
    );

    console.log(
      "CORS enabled"
    );

    console.log(
      "FFmpeg /cut endpoint ready"
    );

    console.log(
      "================================="
    );
  }
);
