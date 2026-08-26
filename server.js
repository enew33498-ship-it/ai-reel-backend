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
TIME
==================================================
*/

function now() {
  return new Date().toISOString();
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
      console.log("[CLEANUP] Input deleted:", inputPath);
    }
  } catch (error) {
    console.log(
      "[CLEANUP] Input delete error:",
      error.message
    );
  }

  try {
    if (outputPath && fs.existsSync(outputPath)) {
      fs.unlinkSync(outputPath);
      console.log("[CLEANUP] Output deleted:", outputPath);
    }
  } catch (error) {
    console.log(
      "[CLEANUP] Output delete error:",
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
  (req, res, next) => {

    console.log("");
    console.log("==========================================");
    console.log("[CUT] POST /cut RECEIVED");
    console.log("[CUT] Time:", now());
    console.log("==========================================");

    /*
    Detect if browser/mobile connection disappears
    while uploading or processing.
    */

    req.on("aborted", () => {
      console.log(
        "[REQUEST] CLIENT ABORTED REQUEST"
      );
    });

    req.on("close", () => {
      console.log(
        "[REQUEST] Request stream closed"
      );
    });

    next();
  },

  upload.single("video"),

  async (req, res) => {

    let inputPath = null;
    let outputPath = null;
    let ffmpegProcess = null;
    let responseStarted = false;
    let cleaned = false;

    const cleanup = () => {
      if (cleaned) return;

      cleaned = true;

      cleanupFiles(
        inputPath,
        outputPath
      );
    };

    /*
    ==============================================
    RESPONSE CONNECTION EVENTS
    ==============================================
    */

    res.on("close", () => {
      console.log(
        "[RESPONSE] Response connection CLOSED"
      );

      if (!responseStarted) {
        console.log(
          "[RESPONSE] Connection closed BEFORE response started"
        );
      }
    });

    res.on("finish", () => {
      console.log(
        "[RESPONSE] Response FINISHED successfully"
      );

      cleanup();
    });

    try {

      /*
      ============================================
      MULTER / UPLOAD COMPLETE
      ============================================
      */

      console.log(
        "[UPLOAD] Multer processing finished"
      );

      if (!req.file) {

        console.log(
          "[ERROR] No video received"
        );

        return res.status(400).json({
          error: "No video file received.",
        });
      }

      inputPath = req.file.path;

      let start = Number(
        req.body.start
      );

      if (!Number.isFinite(start)) {
        start = 0;
      }

      start = Math.max(0, start);

      console.log(
        "[UPLOAD] Original filename:",
        req.file.originalname
      );

      console.log(
        "[UPLOAD] MIME:",
        req.file.mimetype
      );

      console.log(
        "[UPLOAD] Uploaded size:",
        (
          req.file.size /
          1024 /
          1024
        ).toFixed(2),
        "MB"
      );

      console.log(
        "[UPLOAD] Temporary input:",
        inputPath
      );

      console.log(
        "[CUT] Requested start:",
        start,
        "seconds"
      );

      /*
      ============================================
      CHECK INPUT
      ============================================
      */

      if (!fs.existsSync(inputPath)) {

        throw new Error(
          "Uploaded temporary file does not exist."
        );
      }

      const inputStats =
        fs.statSync(inputPath);

      console.log(
        "[INPUT] File exists:",
        inputStats.size,
        "bytes"
      );

      /*
      ============================================
      OUTPUT
      ============================================
      */

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

      const ffmpegPath =
        getFFmpegPath();

      console.log(
        "[FFMPEG] Path:",
        ffmpegPath
      );

      console.log(
        "[FFMPEG] Output:",
        outputPath
      );

      /*
      ============================================
      FFMPEG
      ============================================

      -ss BEFORE -i
      ----------------
      Fast seeking.

      -t 30
      ----------------
      Exact 30-second duration.

      ultrafast
      ----------------
      Faster processing on Render.

      crf 23
      ----------------
      Good quality while reducing CPU/time.

      ============================================
      */

      const args = [

        "-hide_banner",

        "-loglevel",
        "warning",

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
        "ultrafast",

        "-crf",
        "23",

        "-c:a",
        "aac",

        "-b:a",
        "128k",

        "-movflags",
        "+faststart",

        "-avoid_negative_ts",
        "make_zero",

        outputPath,
      ];

      console.log("");
      console.log(
        "[FFMPEG] =================================="
      );

      console.log(
        "[FFMPEG] STARTING"
      );

      console.log(
        "[FFMPEG] Start:",
        start,
        "seconds"
      );

      console.log(
        "[FFMPEG] Duration: 30 seconds"
      );

      console.log(
        "[FFMPEG] Preset: ultrafast"
      );

      console.log(
        "[FFMPEG] =================================="
      );

      const ffmpegStartTime =
        Date.now();

      /*
      ============================================
      START FFMPEG
      ============================================
      */

      await new Promise(
        (resolve, reject) => {

          ffmpegProcess =
            spawn(
              ffmpegPath,
              args
            );

          let stderr = "";

          ffmpegProcess.stderr.on(
            "data",
            (data) => {

              const text =
                data.toString();

              stderr += text;

              const clean =
                text.trim();

              if (clean) {
                console.log(
                  "[FFMPEG]",
                  clean
                );
              }

            }
          );

          ffmpegProcess.stdout.on(
            "data",
            (data) => {

              const text =
                data.toString().trim();

              if (text) {
                console.log(
                  "[FFMPEG-OUT]",
                  text
                );
              }

            }
          );

          ffmpegProcess.on(
            "error",
            (error) => {

              console.error(
                "[FFMPEG] PROCESS ERROR:",
                error
              );

              reject(error);

            }
          );

          ffmpegProcess.on(
            "close",
            (code, signal) => {

              const seconds =
                (
                  (Date.now() -
                    ffmpegStartTime) /
                  1000
                ).toFixed(1);

              console.log(
                "[FFMPEG] FINISHED"
              );

              console.log(
                "[FFMPEG] Exit code:",
                code
              );

              console.log(
                "[FFMPEG] Signal:",
                signal || "none"
              );

              console.log(
                "[FFMPEG] Processing time:",
                seconds,
                "seconds"
              );

              if (code === 0) {

                resolve();

              } else {

                reject(
                  new Error(
                    "FFmpeg failed. Exit code: " +
                      code +
                      " Signal: " +
                      (
                        signal ||
                        "none"
                      ) +
                      "\n" +
                      stderr.slice(-8000)
                  )
                );

              }

            }
          );

        }
      );

      ffmpegProcess = null;

      /*
      ============================================
      OUTPUT CHECK
      ============================================
      */

      console.log(
        "[OUTPUT] Checking MP4..."
      );

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
        "[OUTPUT] MP4 exists"
      );

      console.log(
        "[OUTPUT] Size:",
        (
          stats.size /
          1024 /
          1024
        ).toFixed(2),
        "MB"
      );

      if (stats.size <= 0) {

        throw new Error(
          "Output MP4 is empty."
        );
      }

      /*
      ============================================
      SEND RESPONSE
      ============================================
      */

      console.log(
        "[RESPONSE] Preparing MP4 response..."
      );

      res.statusCode = 200;

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
      Flush headers immediately so browser knows
      response has started.
      */

      if (
        typeof res.flushHeaders ===
        "function"
      ) {
        res.flushHeaders();
      }

      responseStarted = true;

      console.log(
        "[RESPONSE] Sending MP4 to client..."
      );

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

          cleanup();

          if (!res.headersSent) {

            res.status(500).json({
              error:
                "Could not send video.",
              details:
                error.message,
            });

          } else {

            res.destroy(
              error
            );

          }

        }
      );

      stream.on(
        "open",
        () => {

          console.log(
            "[STREAM] MP4 file stream OPEN"
          );

        }
      );

      stream.on(
        "end",
        () => {

          console.log(
            "[STREAM] MP4 stream END"
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
        "[ERROR] VIDEO CREATION FAILED"
      );

      console.error(
        "[ERROR]",
        error.message
      );

      console.error(
        "=========================================="
      );

      /*
      Kill FFmpeg if something failed while it
      was still running.
      */

      if (ffmpegProcess) {

        try {

          console.log(
            "[FFMPEG] Killing running process..."
          );

          ffmpegProcess.kill(
            "SIGKILL"
          );

        } catch (killError) {

          console.log(
            "[FFMPEG] Kill error:",
            killError.message
          );

        }

      }

      cleanup();

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

    console.error("");
    console.error(
      "=========================================="
    );

    console.error(
      "[SERVER ERROR]"
    );

    console.error(
      err
    );

    console.error(
      "=========================================="
    );

    if (
      err instanceof multer.MulterError
    ) {

      if (!res.headersSent) {

        return res.status(400).json({
          error:
            "Upload error",
          details:
            err.message,
          code:
            err.code,
        });

      }

    }

    if (!res.headersSent) {

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
      "Detailed upload + FFmpeg logging enabled"
    );

    console.log(
      "=========================================="
    );

  }
);
