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
    mode: "stream-copy",
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
      "[CLEANUP] Input delete error:",
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
      "[CLEANUP] Output delete error:",
      error.message
    );
  }
}

/*
==================================================
RUN FFMPEG
==================================================
*/

function runFFmpeg(ffmpegPath, args) {
  return new Promise((resolve, reject) => {
    console.log("[FFMPEG] Starting...");

    const ffmpeg = spawn(
      ffmpegPath,
      args
    );

    let stderr = "";

    ffmpeg.stderr.on("data", (data) => {
      const text = data.toString();

      stderr += text;

      console.log(
        "[FFMPEG]",
        text.trim()
      );
    });

    ffmpeg.on("error", (error) => {
      console.error(
        "[FFMPEG] Process error:",
        error
      );

      reject(error);
    });

    ffmpeg.on("close", (code) => {
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
    });
  });
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
      console.log(
        "================================="
      );
      console.log(
        "[CUT] REQUEST RECEIVED"
      );
      console.log(
        "================================="
      );

      /*
      ------------------------------------------
      FILE CHECK
      ------------------------------------------
      */

      if (!req.file) {
        console.log(
          "[CUT] ERROR: No video received"
        );

        return res.status(400).json({
          error:
            "No video file received.",
        });
      }

      inputPath =
        req.file.path;

      /*
      ------------------------------------------
      START
      ------------------------------------------
      */

      let start =
        Number(req.body.start);

      if (!Number.isFinite(start)) {
        start = 0;
      }

      if (start < 0) {
        start = 0;
      }

      start =
        Math.round(start * 1000) /
        1000;

      /*
      ------------------------------------------
      LENGTH
      ------------------------------------------

      We are NOT forcing exactly 30 seconds.

      The client normally sends a 30-second
      candidate window.

      Stream copy may move the beginning to
      a nearby keyframe.

      ------------------------------------------
      */

      let duration =
        Number(req.body.duration);

      if (
        !Number.isFinite(duration) ||
        duration <= 0
      ) {
        duration = 30;
      }

      /*
      Keep the requested clip around
      30 seconds.
      */

      duration =
        Math.max(
          10,
          Math.min(
            60,
            duration
          )
        );

      console.log(
        "[CUT] Original file:",
        req.file.originalname
      );

      console.log(
        "[CUT] Uploaded:",
        (
          req.file.size /
          1024 /
          1024
        ).toFixed(2),
        "MB"
      );

      console.log(
        "[CUT] Requested start:",
        start,
        "seconds"
      );

      console.log(
        "[CUT] Requested duration:",
        duration,
        "seconds"
      );

      /*
      ------------------------------------------
      OUTPUT
      ------------------------------------------
      */

      outputPath = path.join(
        os.tmpdir(),
        "AI_Reel_Copy_" +
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
      ==================================================
      STREAM COPY

      IMPORTANT:

      -c:v copy
      -c:a copy

      means FFmpeg does NOT re-encode the
      video or audio.

      Therefore:

      ✔ Original video speed
      ✔ Original FPS
      ✔ Original quality
      ✔ Original audio
      ✔ Original audio timing
      ✔ Much faster processing
      ✔ Much smaller processing load

      The cut can align to a nearby keyframe.
      That is intentional because we want to
      preserve the original video stream.
      ==================================================
      */

      const args = [
        "-hide_banner",
        "-loglevel",
        "info",

        "-y",

        /*
        Start position.

        Placed before -i so FFmpeg can seek
        quickly to the selected section.
        */

        "-ss",
        String(start),

        "-i",
        inputPath,

        /*
        Approximate clip length.

        Exact frame-level 30.000 sec is NOT
        required by this workflow.
        */

        "-t",
        String(duration),

        /*
        Copy original streams.
        */

        "-map",
        "0:v:0",

        "-map",
        "0:a:0?",

        "-c:v",
        "copy",

        "-c:a",
        "copy",

        /*
        MP4 playback compatibility.
        */

        "-movflags",
        "+faststart",

        /*
        Make timestamps safer for MP4.
        */

        "-avoid_negative_ts",
        "make_zero",

        outputPath,
      ];

      console.log("");
      console.log(
        "[CUT] Using STREAM COPY mode"
      );

      console.log(
        "[CUT] No video re-encoding"
      );

      console.log(
        "[CUT] No audio re-encoding"
      );

      await runFFmpeg(
        ffmpegPath,
        args
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
        "[SUCCESS] Output size:",
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
      RESPONSE HEADERS
      ------------------------------------------
      */

      res.status(200);

      res.setHeader(
        "Content-Type",
        "video/mp4"
      );

      res.setHeader(
        "Content-Disposition",
        'attachment; filename="AI_Reel_Best_Moment.mp4"'
      );

      res.setHeader(
        "Content-Length",
        stats.size
      );

      /*
      ------------------------------------------
      STREAM MP4 TO CLIENT
      ------------------------------------------
      */

      const stream =
        fs.createReadStream(
          outputPath
        );

      stream.on("error", (error) => {
        console.error(
          "[STREAM] Error:",
          error
        );

        cleanupFiles(
          inputPath,
          outputPath
        );
      });

      stream.on("end", () => {
        console.log(
          "[STREAM] MP4 sent completely"
        );
      });

      stream.on("close", () => {
        console.log(
          "[STREAM] Stream closed"
        );

        cleanupFiles(
          inputPath,
          outputPath
        );
      });

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
GENERAL ERROR HANDLER
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
      "STREAM COPY MODE enabled"
    );

    console.log(
      "Original speed / FPS / audio preserved"
    );

    console.log(
      "================================="
    );
  }
);
