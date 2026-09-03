const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

const app = express();

const PORT = process.env.PORT || 10000;


/* =========================================================
   CORS
========================================================= */

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Accept"],
  })
);

app.options("*", cors());

app.use(express.json());


/* =========================================================
   MULTER VIDEO UPLOAD
========================================================= */

const upload = multer({
  dest: os.tmpdir(),

  limits: {
    fileSize: 500 * 1024 * 1024,
  },
});


/* =========================================================
   HEALTH CHECK
========================================================= */

app.get("/", (req, res) => {
  res.status(200).json({
    status: "ok",
    service: "AI Reel High Quality Backend",
    output: "1080x1920",
    ratio: "9:16",
    videoSpeed: "original",
    audio: "original",
    quality: "high",
  });
});


/* =========================================================
   SAFE NUMBER
========================================================= */

function safeNumber(value, fallback) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return fallback;
  }

  return number;
}


/* =========================================================
   CLEANUP FILES
========================================================= */

function cleanupFiles(...files) {
  for (const file of files) {
    try {
      if (file && fs.existsSync(file)) {
        fs.unlinkSync(file);
        console.log("[CLEANUP] Deleted:", file);
      }
    } catch (error) {
      console.error(
        "[CLEANUP ERROR]",
        error.message
      );
    }
  }
}


/* =========================================================
   RUN FFMPEG
========================================================= */

function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", args);

    let stderr = "";

    ffmpeg.stderr.on("data", (data) => {
      const text = data.toString();

      stderr += text;

      process.stdout.write(
        "[FFMPEG] " + text
      );
    });


    ffmpeg.on("error", (error) => {
      reject(
        new Error(
          "FFmpeg could not start: " +
          error.message
        )
      );
    });


    ffmpeg.on("close", (code) => {
      console.log(
        "\n[FFMPEG] Exit code:",
        code
      );

      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            "FFmpeg failed with exit code " +
            code +
            "\n\n" +
            stderr.slice(-8000)
          )
        );
      }
    });
  });
}


/* =========================================================
   POST /CUT
========================================================= */

app.post(
  "/cut",

  upload.single("video"),

  async (req, res) => {

    let inputPath = null;
    let outputPath = null;

    try {

      console.log("\n======================================");
      console.log("NEW AI REEL REQUEST");
      console.log("======================================");


      /* ---------------------------------------------------
         CHECK VIDEO
      --------------------------------------------------- */

      if (!req.file) {
        return res.status(400).json({
          error: "No video file received.",
        });
      }


      inputPath = req.file.path;


      /* ---------------------------------------------------
         START TIME
      --------------------------------------------------- */

      let start = safeNumber(
        req.body.start,
        0
      );

      if (start < 0) {
        start = 0;
      }


      /* ---------------------------------------------------
         DURATION
      --------------------------------------------------- */

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


      /* ---------------------------------------------------
         LOG INFORMATION
      --------------------------------------------------- */

      console.log(
        "[VIDEO]",
        req.file.originalname
      );

      console.log(
        "[INPUT SIZE]",
        (
          req.file.size /
          1024 /
          1024
        ).toFixed(2) + " MB"
      );

      console.log(
        "[START]",
        start + " seconds"
      );

      console.log(
        "[DURATION]",
        duration + " seconds"
      );

      console.log(
        "[OUTPUT]",
        "1080x1920"
      );

      console.log(
        "[RATIO]",
        "9:16"
      );

      console.log(
        "[VIDEO SPEED]",
        "ORIGINAL"
      );

      console.log(
        "[AUDIO]",
        "ORIGINAL"
      );


      /* ---------------------------------------------------
         OUTPUT FILE
      --------------------------------------------------- */

      outputPath = path.join(
        os.tmpdir(),

        "AI_Reel_" +
        Date.now() +
        "_" +
        Math.random()
          .toString(36)
          .slice(2) +
        ".mp4"
      );


      /* =================================================
         HIGH QUALITY VIDEO FILTER

         lanczos = high quality scaling

         scale = fills vertical screen

         crop = exact 1080x1920

         setsar = correct pixel ratio
      ================================================= */

      const videoFilter =
        "scale=1080:1920:" +
        "force_original_aspect_ratio=increase:" +
        "flags=lanczos," +

        "crop=1080:1920," +

        "setsar=1," +

        "format=yuv420p";


      /* =================================================
         FFMPEG COMMAND

         IMPORTANT:

         NO setpts
         NO atempo

         Therefore:

         ✓ Original video speed
         ✓ Original audio speed
      ================================================= */

      const args = [

        "-hide_banner",

        "-y",


        /* START POSITION */

        "-ss",
        String(start),


        /* INPUT VIDEO */

        "-i",
        inputPath,


        /* EXACT CLIP LENGTH */

        "-t",
        String(duration),


        /* VIDEO FILTER */

        "-vf",
        videoFilter,


        /* VIDEO STREAM */

        "-map",
        "0:v:0",


        /* AUDIO STREAM IF AVAILABLE */

        "-map",
        "0:a:0?",


        /* HIGH QUALITY H264 */

        "-c:v",
        "libx264",


        /* GOOD QUALITY / SPEED BALANCE */

        "-preset",
        "medium",


        /*
         CRF 18 = HIGH QUALITY

         Lower CRF = better quality
        */

        "-crf",
        "18",


        /* H264 PROFILE */

        "-profile:v",
        "high",


        "-level:v",
        "4.2",


        /* MAXIMUM QUALITY COMPATIBILITY */

        "-pix_fmt",
        "yuv420p",


        /*
         HIGH VIDEO BITRATE LIMIT
        */

        "-maxrate",
        "12M",


        "-bufsize",
        "24M",


        /* AUDIO */

        "-c:a",
        "aac",


        "-b:a",
        "192k",


        "-ar",
        "48000",


        /*
         FAST PLAYBACK START
        */

        "-movflags",
        "+faststart",


        /* TIMESTAMP FIX */

        "-avoid_negative_ts",
        "make_zero",


        /* OUTPUT */

        outputPath
      ];


      /* ---------------------------------------------------
         SHOW COMMAND
      --------------------------------------------------- */

      console.log("\n[FFMPEG] Starting...");

      console.log(
        "ffmpeg " +
        args.join(" ")
      );


      /* =================================================
         RUN FFMPEG
      ================================================= */

      await runFFmpeg(args);


      /* =================================================
         CHECK OUTPUT
      ================================================= */

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


      if (
        !stats.size ||
        stats.size <= 1000
      ) {
        throw new Error(
          "Created MP4 is empty or invalid."
        );
      }


      console.log("\n======================================");
      console.log("MP4 SUCCESSFULLY CREATED");
      console.log("======================================");

      console.log(
        "[OUTPUT SIZE]",
        (
          stats.size /
          1024 /
          1024
        ).toFixed(2) + " MB"
      );


      /* =================================================
         SEND MP4
      ================================================= */

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
        'attachment; filename="AI_Reel_1080x1920_HighQuality.mp4"'
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
        "X-Video-Quality",
        "high"
      );

      res.setHeader(
        "X-Video-Speed",
        "original"
      );

      res.setHeader(
        "X-Audio",
        "original"
      );

      res.setHeader(
        "X-Duration",
        String(duration)
      );


      /* =================================================
         STREAM VIDEO
      ================================================= */

      const stream =
        fs.createReadStream(outputPath);


      let cleaned = false;


      function cleanupOnce() {

        if (cleaned) return;

        cleaned = true;

        cleanupFiles(
          inputPath,
          outputPath
        );
      }


      stream.on(
        "error",

        (error) => {

          console.error(
            "[STREAM ERROR]",
            error.message
          );

          cleanupOnce();

          if (!res.headersSent) {
            res.status(500).json({
              error: "Could not send MP4.",
              details: error.message,
            });
          }
        }
      );


      res.on(
        "finish",

        () => {

          console.log(
            "[RESPONSE] MP4 sent successfully."
          );

          setTimeout(
            cleanupOnce,
            2000
          );
        }
      );


      res.on(
        "close",

        () => {

          setTimeout(
            cleanupOnce,
            2000
          );
        }
      );


      stream.pipe(res);


    } catch (error) {

      console.error("\n======================================");
      console.error("VIDEO CREATION ERROR");
      console.error("======================================");

      console.error(error);


      cleanupFiles(
        inputPath,
        outputPath
      );


      if (!res.headersSent) {

        res.status(500).json({
          error: "MP4 creation failed.",
          details: error.message,
        });

      }
    }
  }
);


/* =========================================================
   ERROR HANDLER
========================================================= */

app.use(
  (err, req, res, next) => {

    console.error(
      "[SERVER ERROR]",
      err.message
    );


    if (!res.headersSent) {

      res.status(500).json({
        error: "Server error",
        details: err.message,
      });

    }
  }
);


/* =========================================================
   START SERVER
========================================================= */

app.listen(
  PORT,
  "0.0.0.0",

  () => {

    console.log("\n======================================");
    console.log("AI REEL HIGH QUALITY BACKEND STARTED");
    console.log("======================================");

    console.log("Port:", PORT);
    console.log("Output:", "1080x1920");
    console.log("Ratio:", "9:16");
    console.log("Quality:", "HIGH");
    console.log("CRF:", "18");
    console.log("Preset:", "medium");
    console.log("Video Speed:", "ORIGINAL");
    console.log("Audio:", "ORIGINAL");
    console.log("Endpoint:", "/cut");

    console.log("======================================\n");

  }
);
