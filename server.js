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
SERVER SETTINGS
==================================================
*/

app.disable("x-powered-by");

/*
Long video processing ke liye Node connection
timeouts ko high rakha gaya hai.
*/

const serverTimeout = 100 * 60 * 1000; // 100 minutes

/*
==================================================
CORS
==================================================
*/

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization"
    ]
  })
);

/*
==================================================
BODY
==================================================
*/

app.use(
  express.json({
    limit: "10mb"
  })
);

/*
==================================================
UPLOAD
==================================================

Video directly temporary folder mein save hoga.
Memory mein pura video load nahi hoga.
==================================================
*/

const upload = multer({
  dest: os.tmpdir(),

  limits: {
    fileSize: 5 * 1024 * 1024 * 1024
  }
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
    version: "stable-video-cut-v3"
  });

});


app.get("/health", (req, res) => {

  res.status(200).json({
    status: "ok"
  });

});


/*
==================================================
FFMPEG PATH
==================================================
*/

function getFFmpegPath() {

  return (
    process.env.FFMPEG_PATH ||
    "ffmpeg"
  );

}


/*
==================================================
NUMBER HELPER
==================================================
*/

function safeNumber(value, fallback) {

  const number =
    Number(value);

  if (!Number.isFinite(number)) {
    return fallback;
  }

  return number;

}


/*
==================================================
CLEANUP
==================================================
*/

function cleanupFiles(
  inputPath,
  outputPath
) {

  try {

    if (
      inputPath &&
      fs.existsSync(inputPath)
    ) {

      fs.unlinkSync(inputPath);

      console.log(
        "[CLEANUP] Input deleted:",
        inputPath
      );

    }

  } catch (error) {

    console.log(
      "[CLEANUP] Input delete error:",
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
        "[CLEANUP] Output deleted:",
        outputPath
      );

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
FFMPEG RUNNER
==================================================
*/

function runFFmpeg(
  ffmpegPath,
  args
) {

  return new Promise(
    (resolve, reject) => {

      console.log(
        "================================="
      );

      console.log(
        "[FFMPEG] STARTING"
      );

      console.log(
        "[FFMPEG] COMMAND:"
      );

      console.log(
        ffmpegPath,
        args.join(" ")
      );

      console.log(
        "================================="
      );


      const ffmpeg =
        spawn(
          ffmpegPath,
          args,
          {
            stdio: [
              "ignore",
              "pipe",
              "pipe"
            ]
          }
        );


      let stderr = "";
      let stdout = "";


      ffmpeg.stdout.on(
        "data",
        (data) => {

          const text =
            data.toString();

          stdout += text;

          console.log(
            "[FFMPEG STDOUT]",
            text.trim()
          );

        }
      );


      ffmpeg.stderr.on(
        "data",
        (data) => {

          const text =
            data.toString();

          stderr += text;

          /*
          FFmpeg progress yahin milta hai.
          */

          const lines =
            text
              .split(/\r?\n/)
              .filter(Boolean);

          for (const line of lines) {

            console.log(
              "[FFMPEG]",
              line
            );

          }

        }
      );


      ffmpeg.on(
        "error",
        (error) => {

          console.error(
            "[FFMPEG PROCESS ERROR]",
            error
          );

          reject(error);

        }
      );


      ffmpeg.on(
        "close",
        (code, signal) => {

          console.log(
            "[FFMPEG] PROCESS CLOSED"
          );

          console.log(
            "[FFMPEG] CODE:",
            code
          );

          console.log(
            "[FFMPEG] SIGNAL:",
            signal
          );


          if (code === 0) {

            resolve({
              stdout,
              stderr
            });

          } else {

            reject(
              new Error(
                "FFmpeg exited with code " +
                code +
                (signal
                  ? " signal=" + signal
                  : "") +
                "\n" +
                stderr.slice(-8000)
              )
            );

          }

        }
      );

    }
  );

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

    const requestStart =
      Date.now();


    try {

      console.log("");
      console.log(
        "================================="
      );

      console.log(
        "[CUT] NEW REQUEST"
      );

      console.log(
        "================================="
      );


      /*
      ==========================================
      CHECK FILE
      ==========================================
      */

      if (!req.file) {

        console.log(
          "[CUT] ERROR: No video received"
        );

        return res.status(400).json({
          error:
            "No video file received."
        });

      }


      inputPath =
        req.file.path;


      /*
      ==========================================
      CHECK FILE SIZE
      ==========================================
      */

      const inputStats =
        fs.statSync(
          inputPath
        );


      console.log(
        "[CUT] Original filename:",
        req.file.originalname
      );

      console.log(
        "[CUT] Temporary file:",
        inputPath
      );

      console.log(
        "[CUT] Uploaded size:",
        (
          inputStats.size /
          1024 /
          1024
        ).toFixed(2),
        "MB"
      );


      if (
        inputStats.size <= 0
      ) {

        throw new Error(
          "Uploaded video is empty."
        );

      }


      /*
      ==========================================
      START TIME
      ==========================================
      */

      let start =
        safeNumber(
          req.body.start,
          0
        );


      if (start < 0) {
        start = 0;
      }


      /*
      ==========================================
      DURATION
      ==========================================

      Frontend duration bhej sakta hai.

      Agar duration nahi bheja gaya:
      default = 30 seconds.

      ==========================================
      */

      let duration =
        safeNumber(
          req.body.duration,
          30
        );


      /*
      Minimum 1 second.
      */

      if (duration < 1) {
        duration = 1;
      }


      /*
      Maximum 10 minutes.

      Baad mein isko badha sakte hain.
      */

      if (duration > 600) {

        duration = 600;

      }


      console.log(
        "[CUT] Start:",
        start,
        "seconds"
      );

      console.log(
        "[CUT] Duration:",
        duration,
        "seconds"
      );


      /*
      ==========================================
      OUTPUT
      ==========================================
      */

      outputPath =
        path.join(
          os.tmpdir(),
          "AI_REEL_" +
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
      ==========================================
      FFMPEG
      ==========================================

      IMPORTANT:

      -ss before -i
      = fast seeking

      -t duration
      = requested output duration

      -c:v libx264
      = normal compatible MP4

      -preset superfast
      = faster rendering

      -crf 21
      = good quality without making
        unnecessarily huge files

      -c:a aac
      = compatible audio

      IMPORTANT:
      Video speed is NOT changed.

      No:
      -filter:v setpts
      -filter_complex
      -speed
      etc.

      Therefore original playback speed remains.
      ==========================================
      */

      const args = [

        "-hide_banner",

        "-loglevel",
        "info",

        "-y",

        /*
        Fast seek
        */

        "-ss",
        String(start),

        "-i",
        inputPath,

        /*
        Output duration
        */

        "-t",
        String(duration),

        /*
        Video
        */

        "-map",
        "0:v:0",

        /*
        Audio optional
        */

        "-map",
        "0:a:0?",

        /*
        Video encoding
        */

        "-c:v",
        "libx264",

        "-preset",
        "superfast",

        "-crf",
        "21",

        /*
        Keep original FPS
        */

        "-fps_mode",
        "passthrough",

        /*
        Audio
        */

        "-c:a",
        "aac",

        "-b:a",
        "128k",

        /*
        Better MP4 compatibility
        */

        "-movflags",
        "+faststart",

        /*
        Clean timestamps
        */

        "-avoid_negative_ts",
        "make_zero",

        outputPath

      ];


      /*
      ==========================================
      RUN FFMPEG
      ==========================================
      */

      await runFFmpeg(
        ffmpegPath,
        args
      );


      /*
      ==========================================
      CHECK OUTPUT
      ==========================================
      */

      if (
        !fs.existsSync(
          outputPath
        )
      ) {

        throw new Error(
          "FFmpeg finished but MP4 was not created."
        );

      }


      const outputStats =
        fs.statSync(
          outputPath
        );


      console.log(
        "[CUT] Output size:",
        (
          outputStats.size /
          1024 /
          1024
        ).toFixed(2),
        "MB"
      );


      if (
        outputStats.size <= 0
      ) {

        throw new Error(
          "Output MP4 is empty."
        );

      }


      /*
      ==========================================
      SEND MP4
      ==========================================
      */

      console.log(
        "[CUT] Sending MP4 to browser..."
      );


      res.statusCode =
        200;


      res.setHeader(
        "Content-Type",
        "video/mp4"
      );


      res.setHeader(
        "Content-Disposition",
        'attachment; filename="AI_Reel_Best_Clip.mp4"'
      );


      res.setHeader(
        "Content-Length",
        outputStats.size
      );


      res.setHeader(
        "Cache-Control",
        "no-store"
      );


      const stream =
        fs.createReadStream(
          outputPath
        );


      let sentBytes = 0;


      stream.on(
        "data",
        (chunk) => {

          sentBytes +=
            chunk.length;

          const percent =
            (
              sentBytes /
              outputStats.size
            ) *
            100;


          console.log(
            "[DOWNLOAD]",
            percent.toFixed(1) +
            "%",
            "(" +
            (
              sentBytes /
              1024 /
              1024
            ).toFixed(2) +
            " MB)"
          );

        }
      );


      stream.on(
        "error",
        (error) => {

          console.error(
            "[DOWNLOAD] Stream error:",
            error
          );


          cleanupFiles(
            inputPath,
            outputPath
          );


          if (
            !res.headersSent
          ) {

            res.status(
              500
            ).json({
              error:
                "Could not send video.",
              details:
                error.message
            });

          }

        }
      );


      stream.on(
        "end",
        () => {

          console.log(
            "[CUT] MP4 successfully sent."
          );

          console.log(
            "[CUT] Total request time:",
            (
              (Date.now() -
                requestStart) /
              1000
            ).toFixed(1),
            "seconds"
          );

        }
      );


      stream.on(
        "close",
        () => {

          console.log(
            "[CUT] Output stream closed."
          );


          /*
          Thoda delay taaki response
          completely finish ho jaye.
          */

          setTimeout(
            () => {

              cleanupFiles(
                inputPath,
                outputPath
              );

            },
            2000
          );

        }
      );


      stream.pipe(
        res
      );


    } catch (error) {

      console.error("");
      console.error(
        "================================="
      );

      console.error(
        "[CUT] VIDEO CREATION ERROR"
      );

      console.error(
        error.message
      );

      console.error(
        "================================="
      );


      cleanupFiles(
        inputPath,
        outputPath
      );


      if (
        !res.headersSent
      ) {

        res.status(500).json({

          error:
            "Video creation failed.",

          details:
            error.message

        });

      }

    }

  }
);


/*
==================================================
MULTER ERROR HANDLER
==================================================
*/

app.use(
  (err, req, res, next) => {

    console.error(
      "[GLOBAL ERROR]",
      err
    );


    if (
      err &&
      err.code ===
        "LIMIT_FILE_SIZE"
    ) {

      return res.status(413).json({

        error:
          "Video file is too large.",

        details:
          "Maximum upload size is 5 GB."

      });

    }


    if (
      !res.headersSent
    ) {

      res.status(500).json({

        error:
          "Server error.",

        details:
          err.message ||
          "Unknown server error."

      });

    }

  }
);


/*
==================================================
START SERVER
==================================================
*/

const server =
  app.listen(
    PORT,
    "0.0.0.0",
    () => {

      console.log("");
      console.log(
        "================================="
      );

      console.log(
        "AI REEL BACKEND"
      );

      console.log(
        "Server running on port:",
        PORT
      );

      console.log(
        "FFmpeg endpoint: /cut"
      );

      console.log(
        "Maximum upload: 5 GB"
      );

      console.log(
        "Default clip duration: 30 sec"
      );

      console.log(
        "Maximum clip duration: 600 sec"
      );

      console.log(
        "Original playback speed preserved"
      );

      console.log(
        "================================="
      );

    }
  );


/*
==================================================
NODE TIMEOUTS
==================================================
*/

server.requestTimeout =
  serverTimeout;

server.headersTimeout =
  serverTimeout + 10000;

server.keepAliveTimeout =
  120000;


/*
==================================================
ERROR PROTECTION
==================================================
*/

process.on(
  "uncaughtException",
  (error) => {

    console.error(
      "[UNCAUGHT EXCEPTION]",
      error
    );

  }
);


process.on(
  "unhandledRejection",
  (error) => {

    console.error(
      "[UNHANDLED REJECTION]",
      error
    );

  }
);
