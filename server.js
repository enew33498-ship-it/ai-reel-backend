const express = require("express");
const multer = require("multer");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const crypto = require("crypto");

const app = express();

const PORT = process.env.PORT || 10000;

// -----------------------------
// MIDDLEWARE
// -----------------------------
app.use(cors());
app.use(express.json({ limit: "50mb" }));

// -----------------------------
// UPLOAD SETTINGS
// -----------------------------
const uploadDir = "/tmp/uploads";

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },

  filename: (req, file, cb) => {
    const uniqueName =
      Date.now() +
      "-" +
      crypto.randomBytes(8).toString("hex") +
      path.extname(file.originalname || ".mp4");

    cb(null, uniqueName);
  }
});

const upload = multer({
  storage,

  limits: {
    fileSize: 500 * 1024 * 1024
  }
});

// -----------------------------
// HOME / WAKE ENDPOINT
// -----------------------------
app.get("/", (req, res) => {
  res.status(200).json({
    status: "online",
    service: "AI REEL HIGH QUALITY BACKEND",
    output: "1080x1920",
    ratio: "9:16",
    quality: "MAX PRACTICAL QUALITY",
    videoSpeed: "ORIGINAL",
    audio: "ORIGINAL"
  });
});

app.get("/health", (req, res) => {
  res.status(200).json({
    ok: true,
    status: "healthy"
  });
});

// -----------------------------
// CREATE VIDEO
// -----------------------------
app.post("/cut", upload.any(), async (req, res) => {

  let inputPath = null;
  let outputPath = null;

  try {

    console.log("");
    console.log("================================");
    console.log("[CUT] NEW HIGH QUALITY REQUEST");
    console.log("================================");

    // Accept any uploaded field name
    const file = req.files && req.files.length
      ? req.files[0]
      : null;

    if (!file) {
      return res.status(400).json({
        error: "No video file received."
      });
    }

    inputPath = file.path;

    const start = Number(req.body.start || 0);
    const duration = Number(req.body.duration || 30);

    if (!Number.isFinite(start) || start < 0) {
      return res.status(400).json({
        error: "Invalid start time."
      });
    }

    if (!Number.isFinite(duration) || duration <= 0) {
      return res.status(400).json({
        error: "Invalid duration."
      });
    }

    const outputName =
      "AI_Reel_" +
      Date.now() +
      "_" +
      crypto.randomBytes(6).toString("hex") +
      ".mp4";

    outputPath = path.join("/tmp", outputName);

    console.log("[INPUT]", file.originalname);
    console.log(
      "[SIZE]",
      (file.size / 1024 / 1024).toFixed(2) + " MB"
    );
    console.log("[START]", start);
    console.log("[DURATION]", duration);
    console.log("[OUTPUT] 1080x1920");
    console.log("[QUALITY] HIGH");
    console.log("[VIDEO SPEED] ORIGINAL");
    console.log("[AUDIO] ORIGINAL");

    /*
      IMPORTANT:

      Original video is landscape.
      This creates a 9:16 vertical reel by:

      1. Scaling with Lanczos
      2. Filling 1080x1920
      3. Center cropping
      4. Keeping original playback speed
      5. Copying original AAC audio without re-encoding
    */

    const vf =
      "scale=1080:1920:" +
      "force_original_aspect_ratio=increase:" +
      "flags=lanczos," +
      "crop=1080:1920," +
      "setsar=1," +
      "format=yuv420p";

    const ffmpegArgs = [

      "-hide_banner",
      "-y",

      // Accurate seeking
      "-ss",
      String(start),

      "-i",
      inputPath,

      "-t",
      String(duration),

      "-vf",
      vf,

      // Video
      "-map",
      "0:v:0",

      // Audio if available
      "-map",
      "0:a:0?",

      // High quality H.264
      "-c:v",
      "libx264",

      // Better compression/quality than veryfast
      "-preset",
      "medium",

      // Higher quality
      "-crf",
      "17",

      "-profile:v",
      "high",

      "-level:v",
      "4.2",

      "-pix_fmt",
      "yuv420p",

      // Quality bitrate safety
      "-maxrate",
      "14M",

      "-bufsize",
      "28M",

      // Preserve original audio stream
      "-c:a",
      "copy",

      // Better MP4 streaming
      "-movflags",
      "+faststart",

      outputPath
    ];

    console.log("");
    console.log("[FFMPEG STARTING]");
    console.log("ffmpeg " + ffmpegArgs.join(" "));
    console.log("");

    const ffmpeg = spawn("ffmpeg", ffmpegArgs);

    let ffmpegError = "";

    ffmpeg.stderr.on("data", (data) => {

      const text = data.toString();

      // Render logs
      process.stdout.write("[FFMPEG] " + text);

      ffmpegError += text;

      // Prevent unlimited memory growth
      if (ffmpegError.length > 20000) {
        ffmpegError =
          ffmpegError.slice(-20000);
      }
    });

    ffmpeg.on("error", (error) => {

      console.error(
        "[FFMPEG SPAWN ERROR]",
        error.message
      );

      if (inputPath && fs.existsSync(inputPath)) {
        fs.unlinkSync(inputPath);
      }

      return res.status(500).json({
        error: "FFmpeg could not start.",
        details: error.message
      });
    });

    ffmpeg.on("close", (code) => {

      console.log("");
      console.log("[FFMPEG EXIT CODE]", code);

      if (code !== 0) {

        console.error("[FFMPEG FAILED]");

        if (
          inputPath &&
          fs.existsSync(inputPath)
        ) {
          fs.unlinkSync(inputPath);
        }

        return res.status(500).json({
          error: "Video creation failed.",
          details: ffmpegError.slice(-3000)
        });
      }

      if (
        !outputPath ||
        !fs.existsSync(outputPath)
      ) {

        console.error(
          "[ERROR] Output file missing"
        );

        return res.status(500).json({
          error: "Output video was not created."
        });
      }

      const outputSize =
        fs.statSync(outputPath).size;

      console.log("");
      console.log("================================");
      console.log("[SUCCESS] VIDEO CREATED");
      console.log(
        "[OUTPUT SIZE]",
        (outputSize / 1024 / 1024).toFixed(2) + " MB"
      );
      console.log("[RESOLUTION] 1080x1920");
      console.log("[QUALITY] CRF 17");
      console.log("[SPEED] ORIGINAL");
      console.log("[AUDIO] ORIGINAL STREAM");
      console.log("================================");

      // Delete uploaded source
      if (
        inputPath &&
        fs.existsSync(inputPath)
      ) {
        try {
          fs.unlinkSync(inputPath);
        } catch (e) {
          console.error(
            "[CLEANUP INPUT ERROR]",
            e.message
          );
        }
      }

      res.setHeader(
        "Content-Type",
        "video/mp4"
      );

      res.setHeader(
        "Content-Disposition",
        'attachment; filename="AI_Reel_HighQuality_1080x1920.mp4"'
      );

      const stream =
        fs.createReadStream(outputPath);

      stream.pipe(res);

      stream.on("close", () => {

        if (
          outputPath &&
          fs.existsSync(outputPath)
        ) {
          try {
            fs.unlinkSync(outputPath);

            console.log(
              "[CLEANUP] Output deleted from server"
            );

          } catch (e) {
            console.error(
              "[CLEANUP OUTPUT ERROR]",
              e.message
            );
          }
        }
      });

      stream.on("error", (error) => {

        console.error(
          "[STREAM ERROR]",
          error.message
        );

        if (!res.headersSent) {
          res.status(500).end();
        }
      });
    });

  } catch (error) {

    console.error("");
    console.error("================================");
    console.error("[SERVER ERROR]");
    console.error(error);
    console.error("================================");

    if (
      inputPath &&
      fs.existsSync(inputPath)
    ) {
      try {
        fs.unlinkSync(inputPath);
      } catch (e) {}
    }

    if (
      outputPath &&
      fs.existsSync(outputPath)
    ) {
      try {
        fs.unlinkSync(outputPath);
      } catch (e) {}
    }

    if (!res.headersSent) {
      res.status(500).json({
        error: "Server error while creating video.",
        details: error.message
      });
    }
  }
});

// -----------------------------
// 404
// -----------------------------
app.use((req, res) => {
  res.status(404).json({
    error: "Route not found."
  });
});

// -----------------------------
// START SERVER
// -----------------------------
app.listen(PORT, "0.0.0.0", () => {

  console.log("");
  console.log("================================");
  console.log("AI REEL MAX QUALITY BACKEND");
  console.log("================================");
  console.log("PORT:", PORT);
  console.log("OUTPUT: 1080x1920");
  console.log("RATIO: 9:16");
  console.log("QUALITY: MAX PRACTICAL");
  console.log("VIDEO SPEED: ORIGINAL");
  console.log("AUDIO: ORIGINAL");
  console.log("CRF: 17");
  console.log("PRESET: MEDIUM");
  console.log("AUDIO MODE: COPY");
  console.log("================================");
  console.log("");
});
