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
CLEANUP
==================================================
*/

function cleanupFiles(inputPath, outputPath) {
  try {
    if (inputPath && fs.existsSync(inputPath)) {
      fs.unlinkSync(inputPath);
      console.log("[CLEANUP] Input deleted");
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
      console.log("[CLEANUP] Output deleted");
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
CUT VIDEO
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
      console.log("=================================");
      console.log("[CUT] REQUEST RECEIVED");
      console.log("=================================");

      /*
      ------------------------------------------
      CHECK FILE
      ------------------------------------------
      */

      if (!req.file) {
        console.log("[CUT] ERROR: No video received");

        return res.status(400).json({
          error: "No video file received.",
        });
      }

      inputPath = req.file.path;

      /*
      ------------------------------------------
      START TIME
      ------------------------------------------
      */

      let start = Number(req.body.start);

      if (!Number.isFinite(start)) {
        start = 0;
      }

      if (start < 0) {
        start = 0;
      }

      start = Math.round(start * 100) / 100;

      console.log(
        "[CUT] Original file:",
        req.file.originalname
      );

      console.log(
        "[CUT] Uploaded size:",
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

      /*
      ------------------------------------------
      OUTPUT
      ------------------------------------------
      */

      outputPath = path.join(
        os.tmpdir(),
        "AI_Reel_30s_" +
          Date.now() +
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
      ==================================================
      FFMPEG SETTINGS
      ==================================================

      30 seconds exactly

      H.264:
      - good Android compatibility
      - smooth MP4 playback

      CRF:
      - controls quality/file size

      maxrate/bufsize:
      - prevents unnecessarily huge files

      AAC:
      - standard MP4 audio

      faststart:
      - helps MP4 start playing properly

      ==================================================
      */

      const args = [
        "-hide_banner",
        "-loglevel",
        "info",

        "-y",

        /*
        Start position
        */
        "-ss",
        String(start),

        /*
        Input
        */
        "-i",
        inputPath,

        /*
        EXACTLY 30 SECONDS
        */
        "-t",
        "30",

        /*
        VIDEO
        */
        "-map",
        "0:v:0",

        /*
        AUDIO IF AVAILABLE
        */
        "-map",
        "0:a:0?",

        /*
        H.264
        */
        "-c:v",
        "libx264",

        /*
        Fast enough for Render
        */
        "-preset",
        "veryfast",

        /*
        Quality
        */
        "-crf",
        "21",

        /*
        Prevent huge output
        */
        "-maxrate",
        "5M",

        "-bufsize",
        "10M",

        /*
        Pixel format supported
        by most phones
        */
        "-pix_fmt",
        "yuv420p",

        /*
        AUDIO
        */
        "-c:a",
        "aac",

        "-b:a",
        "128k",

        /*
        Audio sample rate
        */
        "-ar",
        "48000",

        /*
        MP4 compatibility
        */
        "-movflags",
        "+faststart",

        /*
        Clean timestamps
        */
        "-avoid_negative_ts",
        "make_zero",

        /*
        OUTPUT
        */
        outputPath,
      ];

      console.log("");
      console.log(
        "[FFMPEG] Starting encoding..."
      );

      console.log(
        "[FFMPEG] 30-second output"
      );

      /*
      ------------------------------------------
      RUN FFMPEG
      ------------------------------------------
      */

      await new Promise(
        (resolve, reject) => {
          const ffmpeg =
            spawn(
              ffmpegPath,
              args
            );

          let stderr = "";

          ffmpeg.stderr.on(
            "data",
            (data) => {
              const text =
                data.toString();

              stderr += text;

              /*
              Show FFmpeg logs
              in Render
              */

              console.log(
                "[FFMPEG]",
                text.trim()
              );
            }
          );

          ffmpeg.on(
            "error",
            (error) => {
              console.error(
                "[FFMPEG] PROCESS ERROR:",
                error
              );

              reject(error);
            }
          );

          ffmpeg.on(
            "close",
            (code) => {
              console.log(
                "[FFMPEG] Finished with code:",
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
      ------------------------------------------
      CHECK OUTPUT
      ------------------------------------------
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

      if (stats.size <= 0) {
        throw new Error(
          "Output MP4 is empty."
        );
      }

      console.log("");
      console.log(
        "================================="
      );

      console.log(
        "[SUCCESS] MP4 CREATED"
      );

      console.log(
        "[SUCCESS] Size:",
        (
          stats.size /
          1024 /
          1024
        ).toFixed(2),
        "MB"
      );

      console.log(
        "================================="
      );

      /*
      ------------------------------------------
      SEND MP4
      ------------------------------------------
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

      /*
      ------------------------------------------
      STREAM OUTPUT
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
        }
      );

      stream.on(
        "end",
        () => {
          console.log(
            "[STREAM] MP4 SENT COMPLETELY"
          );
        }
      );

      stream.on(
        "close",
        () => {
          console.log(
            "[STREAM] Connection closed"
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
        "================================="
      );

      console.error(
        "[CUT] VIDEO CREATION ERROR"
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
      "30-second MP4 mode enabled"
    );

    console.log(
      "H.264 + AAC + faststart"
    );

    console.log(
      "================================="
    );
  }
);
