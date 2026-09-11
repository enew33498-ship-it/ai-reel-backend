const express = require("express");
const multer = require("multer");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

const app = express();

const PORT = process.env.PORT || 10000;

/* =========================================================
   BASIC SETTINGS
========================================================= */

app.disable("x-powered-by");

app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Accept"]
}));

app.use(express.json({
  limit: "10mb"
}));

/* =========================================================
   TEMP DIRECTORIES
========================================================= */

const baseTempDir = path.join(os.tmpdir(), "ai-reel-editor");
const uploadDir = path.join(baseTempDir, "uploads");
const outputDir = path.join(baseTempDir, "outputs");

for (const dir of [baseTempDir, uploadDir, outputDir]) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/* =========================================================
   MULTER
========================================================= */

const storage = multer.diskStorage({

  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },

  filename: (req, file, cb) => {

    const ext =
      path.extname(file.originalname || ".mp4")
        .toLowerCase() || ".mp4";

    const filename =
      "input-" +
      Date.now() +
      "-" +
      Math.random()
        .toString(36)
        .substring(2, 10) +
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

/* =========================================================
   HEALTH CHECK
========================================================= */

app.get("/", (req, res) => {

  res.status(200).json({
    status: "ok",
    service: "AI Reel FFmpeg Backend",
    message: "Server is ready"
  });

});

app.get("/health", (req, res) => {

  res.status(200).json({
    status: "ok",
    service: "AI Reel FFmpeg Backend"
  });

});

/* =========================================================
   FFPROBE CHECK
========================================================= */

function runCommand(command, args) {

  return new Promise((resolve, reject) => {

    const process = spawn(command, args);

    let stdout = "";
    let stderr = "";

    process.stdout.on("data", data => {
      stdout += data.toString();
    });

    process.stderr.on("data", data => {
      stderr += data.toString();
    });

    process.on("error", error => {
      reject(error);
    });

    process.on("close", code => {

      if (code === 0) {
        resolve({
          stdout,
          stderr
        });
      } else {

        reject(
          new Error(
            command +
            " failed with code " +
            code +
            "\n" +
            stderr.slice(-3000)
          )
        );

      }

    });

  });

}

/* =========================================================
   VIDEO CUT
========================================================= */

app.post(
  "/cut",

  (req, res, next) => {

    console.log("\n========================================");
    console.log("[CUT] REQUEST RECEIVED");
    console.log("========================================");

    upload.single("video")(req, res, error => {

      if (error) {

        console.error(
          "[UPLOAD ERROR]",
          error.message
        );

        if (error instanceof multer.MulterError) {

          return res.status(400).json({
            error: "Upload failed",
            details: error.message
          });

        }

        return res.status(400).json({
          error: "Upload error",
          details: error.message
        });

      }

      next();

    });

  },

  async (req, res) => {

    let inputPath = null;
    let outputPath = null;

    try {

      console.log("\n----------------------------------------");
      console.log("[CUT] PROCESSING STARTED");
      console.log("----------------------------------------");

      /* -----------------------------------------
         CHECK UPLOAD
      ----------------------------------------- */

      if (!req.file) {

        return res.status(400).json({
          error: "No video uploaded",
          details: "Field name must be 'video'"
        });

      }

      inputPath = req.file.path;

      console.log(
        "[INPUT FILE]",
        req.file.originalname
      );

      console.log(
        "[SAVED FILE]",
        inputPath
      );

      console.log(
        "[FILE SIZE]",
        (
          req.file.size /
          1024 /
          1024
        ).toFixed(2) +
        " MB"
      );

      /* -----------------------------------------
         START TIME
      ----------------------------------------- */

      let start = Number(req.body.start);

      if (!Number.isFinite(start)) {
        start = 0;
      }

      if (start < 0) {
        start = 0;
      }

      /* -----------------------------------------
         DURATION
      ----------------------------------------- */

      let duration =
        Number(
          req.body.duration ||
          req.body.clipDuration
        );

      if (!Number.isFinite(duration)) {
        duration = 30;
      }

      /*
        The editor is designed for exact 30-second
        Shorts. We still allow up to 600 seconds
        for backend flexibility.
      */

      if (duration <= 0 || duration > 600) {

        return res.status(400).json({
          error: "Invalid duration",
          details: "Duration must be between 0 and 600 seconds."
        });

      }

      console.log(
        "[START]",
        start.toFixed(3) + " sec"
      );

      console.log(
        "[DURATION]",
        duration.toFixed(3) + " sec"
      );

      /* -----------------------------------------
         VERIFY FFMPEG
      ----------------------------------------- */

      console.log("[CHECK] Checking FFmpeg...");

      try {

        await runCommand(
          "ffmpeg",
          [
            "-version"
          ]
        );

        console.log("[CHECK] FFmpeg available");

      } catch (error) {

        throw new Error(
          "FFmpeg is not available on the Render server. " +
          error.message
        );

      }

      /* -----------------------------------------
         VERIFY INPUT VIDEO
      ----------------------------------------- */

      console.log("[CHECK] Reading video information...");

      let probeData = null;

      try {

        const probe =
          await runCommand(
            "ffprobe",
            [
              "-v",
              "error",

              "-show_entries",
              "format=duration",

              "-of",
              "default=noprint_wrappers=1:nokey=1",

              inputPath
            ]
          );

        probeData =
          Number(
            probe.stdout.trim()
          );

      } catch (error) {

        console.log(
          "[FFPROBE WARNING]",
          error.message
        );

      }

      if (
        Number.isFinite(probeData) &&
        probeData > 0
      ) {

        console.log(
          "[VIDEO DURATION]",
          probeData.toFixed(3) + " sec"
        );

        /*
          Prevent asking FFmpeg to start beyond
          the actual video.
        */

        if (start >= probeData) {

          return res.status(400).json({
            error: "Invalid start time",
            details:
              "Start time is beyond the video duration."
          });

        }

        /*
          If requested section reaches beyond the
          end, reduce it so FFmpeg does not fail.
        */

        if (start + duration > probeData) {

          const remaining =
            probeData - start;

          if (remaining > 0) {

            duration =
              Math.min(
                duration,
                remaining
              );

            console.log(
              "[ADJUSTED DURATION]",
              duration.toFixed(3) +
              " sec"
            );

          }

        }

      }

      /* -----------------------------------------
         OUTPUT FILE
      ----------------------------------------- */

      outputPath =
        path.join(
          outputDir,

          "AI_Reel_" +
          Date.now() +
          "-" +
          Math.random()
            .toString(36)
            .substring(2, 10) +
          ".mp4"
        );

      console.log(
        "[OUTPUT]",
        outputPath
      );

      /* =================================================
         FFMPEG

         - Original playback speed
         - Original audio
         - 30-second clip
         - 9:16
         - 1080x1920
         - H.264
         - AAC
         - Fast start
      ================================================= */

      const ffmpegArgs = [

        "-hide_banner",

        "-loglevel",
        "info",

        "-nostdin",

        "-y",

        /* Accurate enough seeking */
        "-ss",
        String(start),

        "-i",
        inputPath,

        "-t",
        String(duration),

        /* ---------------------------------------
           VIDEO
        --------------------------------------- */

        "-map",
        "0:v:0",

        /* ---------------------------------------
           AUDIO
        --------------------------------------- */

        "-map",
        "0:a:0?",

        /*
          Scale while preserving the original
          aspect ratio, then crop to 1080x1920.
        */

        "-vf",

        "scale=1080:1920:force_original_aspect_ratio=increase:flags=bicubic,crop=1080:1920,setsar=1,format=yuv420p",

        "-c:v",
        "libx264",

        /*
          CRF 18 = very good quality while being
          somewhat easier on Render than CRF 17.
        */

        "-crf",
        "18",

        "-preset",
        "veryfast",

        "-profile:v",
        "high",

        "-level:v",
        "4.2",

        "-pix_fmt",
        "yuv420p",

        /* ---------------------------------------
           AUDIO
        --------------------------------------- */

        "-c:a",
        "aac",

        "-b:a",
        "192k",

        "-ar",
        "48000",

        /*
          Prevent timestamp/speed problems.
        */

        "-vsync",
        "cfr",

        "-movflags",
        "+faststart",

        outputPath

      ];

      console.log("\n----------------------------------------");
      console.log("[FFMPEG] STARTING");
      console.log("----------------------------------------");

      console.log(
        "ffmpeg " +
        ffmpegArgs.join(" ")
      );

      /* -----------------------------------------
         RUN FFMPEG
      ----------------------------------------- */

      await new Promise(
        (resolve, reject) => {

          const ffmpeg =
            spawn(
              "ffmpeg",
              ffmpegArgs,
              {
                stdio: [
                  "ignore",
                  "pipe",
                  "pipe"
                ]
              }
            );

          let stderr = "";
          let finished = false;

          ffmpeg.stdout.on(
            "data",
            data => {

              console.log(
                "[FFMPEG STDOUT]",
                data.toString().trim()
              );

            }
          );

          ffmpeg.stderr.on(
            "data",
            data => {

              const text =
                data.toString();

              stderr += text;

              /*
                FFmpeg normally writes progress
                information to stderr.
              */

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

          ffmpeg.on(
            "error",
            error => {

              if (finished) return;

              finished = true;

              reject(error);

            }
          );

          ffmpeg.on(
            "close",
            code => {

              if (finished) return;

              finished = true;

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
                    stderr.slice(-5000)
                  )
                );

              }

            }
          );

        }
      );

      /* -----------------------------------------
         CHECK OUTPUT
      ----------------------------------------- */

      console.log(
        "[CHECK] Checking generated MP4..."
      );

      if (
        !fs.existsSync(outputPath)
      ) {

        throw new Error(
          "FFmpeg finished but output MP4 was not created."
        );

      }

      const stats =
        fs.statSync(
          outputPath
        );

      if (
        !stats.size ||
        stats.size < 1000
      ) {

        throw new Error(
          "Generated MP4 is empty or invalid."
        );

      }

      console.log(
        "[OUTPUT SIZE]",
        (
          stats.size /
          1024 /
          1024
        ).toFixed(2) +
        " MB"
      );

      /* -----------------------------------------
         VERIFY OUTPUT WITH FFPROBE
      ----------------------------------------- */

      try {

        const outputProbe =
          await runCommand(
            "ffprobe",
            [
              "-v",
              "error",

              "-show_entries",
              "format=duration",

              "-of",
              "default=noprint_wrappers=1:nokey=1",

              outputPath
            ]
          );

        const outputDuration =
          Number(
            outputProbe.stdout.trim()
          );

        console.log(
          "[OUTPUT DURATION]",
          Number.isFinite(outputDuration)
            ? outputDuration.toFixed(3) + " sec"
            : "unknown"
        );

      } catch (error) {

        console.log(
          "[OUTPUT PROBE WARNING]",
          error.message
        );

      }

      /* -----------------------------------------
         RESPONSE HEADERS
      ----------------------------------------- */

      res.statusCode = 200;

      res.setHeader(
        "Content-Type",
        "video/mp4"
      );

      res.setHeader(
        "Content-Length",
        String(stats.size)
      );

      res.setHeader(
        "Content-Disposition",
        'attachment; filename="AI_Reel_Best_30_Seconds.mp4"'
      );

      res.setHeader(
        "Cache-Control",
        "no-store"
      );

      /* -----------------------------------------
         SEND MP4
      ----------------------------------------- */

      console.log(
        "[RESPONSE] Sending MP4 to browser..."
      );

      const stream =
        fs.createReadStream(
          outputPath
        );

      stream.on(
        "error",
        error => {

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

            res.destroy(error);

          }

        }
      );

      stream.pipe(res);

      /*
        Cleanup after response is finished or
        connection is closed.
      */

      const cleanup =
        () => {

          try {

            if (
              inputPath &&
              fs.existsSync(inputPath)
            ) {

              fs.unlinkSync(
                inputPath
              );

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

              fs.unlinkSync(
                outputPath
              );

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

        };

      res.on(
        "finish",
        () => {

          console.log(
            "[RESPONSE] MP4 SENT SUCCESSFULLY"
          );

          cleanup();

        }
      );

      res.on(
        "close",
        () => {

          /*
            If browser closes the connection,
            remove temporary files too.
          */

          if (
            !res.writableFinished
          ) {

            console.log(
              "[RESPONSE] Connection closed early"
            );

            cleanup();

          }

        }
      );

    } catch (error) {

      console.error(
        "\n========================================"
      );

      console.error(
        "[CUT ERROR]"
      );

      console.error(
        error.message
      );

      console.error(
        "========================================\n"
      );

      /* -----------------------------------------
         CLEANUP AFTER ERROR
      ----------------------------------------- */

      try {

        if (
          inputPath &&
          fs.existsSync(inputPath)
        ) {

          fs.unlinkSync(
            inputPath
          );

        }

      } catch {}

      try {

        if (
          outputPath &&
          fs.existsSync(outputPath)
        ) {

          fs.unlinkSync(
            outputPath
          );

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

/* =========================================================
   GLOBAL ERROR HANDLER
========================================================= */

app.use(
  (error, req, res, next) => {

    console.error(
      "[SERVER ERROR]",
      error.message
    );

    if (
      res.headersSent
    ) {

      return next(error);

    }

    res.status(500).json({

      error:
        "Server error",

      details:
        error.message

    });

  }
);

/* =========================================================
   START SERVER
========================================================= */

const server =
  app.listen(
    PORT,
    "0.0.0.0",
    () => {

      console.log("");
      console.log("========================================");
      console.log("      AI REEL EDITOR BACKEND");
      console.log("========================================");
      console.log("PORT:", PORT);
      console.log("HOST: 0.0.0.0");
      console.log("OUTPUT: 1080x1920");
      console.log("RATIO: 9:16");
      console.log("VIDEO: H.264");
      console.log("AUDIO: AAC 192k");
      console.log("QUALITY: CRF 18");
      console.log("PRESET: VERYFAST");
      console.log("UPLOAD LIMIT: 500 MB");
      console.log("========================================");
      console.log("");

    }
  );

/* =========================================================
   LONG PROCESSING / CONNECTION SETTINGS
========================================================= */

server.timeout = 0;

server.requestTimeout = 0;

server.headersTimeout = 0;

server.keepAliveTimeout = 120000;

/* =========================================================
   SAFETY CLEANUP
========================================================= */

process.on(
  "SIGTERM",
  () => {

    console.log(
      "[SERVER] SIGTERM received"
    );

    server.close(
      () => {

        console.log(
          "[SERVER] Closed"
        );

        process.exit(0);

      }
    );

  }
);

process.on(
  "SIGINT",
  () => {

    console.log(
      "[SERVER] SIGINT received"
    );

    server.close(
      () => {

        process.exit(0);

      }
    );

  }
);
