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
    allowedHeaders: ["Content-Type", "Accept"],
  })
);

app.use(express.json());


/* ==================================================
UPLOAD
================================================== */

const upload = multer({
  dest: os.tmpdir(),

  limits: {
    fileSize: 500 * 1024 * 1024,
  },
});


/* ==================================================
HEALTH CHECK
================================================== */

app.get("/", (req, res) => {

  res.status(200).json({
    status: "ok",
    service: "AI Reel High Quality Backend",
    output: "1080x1920",
    speed: "original",
    audio: "original",
    quality: "high"
  });

});


/* ==================================================
HELPERS
================================================== */

function safeNumber(value, fallback) {

  const number = Number(value);

  return Number.isFinite(number)
    ? number
    : fallback;

}


function cleanup(...files) {

  for (const file of files) {

    try {

      if (file && fs.existsSync(file)) {
        fs.unlinkSync(file);
      }

    } catch (error) {

      console.error(
        "[CLEANUP ERROR]",
        error.message
      );

    }

  }

}


/* ==================================================
CREATE VIDEO
================================================== */

app.post(
  "/cut",
  upload.single("video"),

  async (req, res) => {

    let inputPath = null;
    let outputPath = null;

    try {

      console.log("================================");
      console.log("[CUT] NEW REQUEST");
      console.log("================================");


      /* ----------------------------------------------
      FILE CHECK
      ---------------------------------------------- */

      if (!req.file) {

        return res.status(400).json({
          error: "No video uploaded."
        });

      }

      inputPath = req.file.path;


      /* ----------------------------------------------
      START
      ---------------------------------------------- */

      let start = safeNumber(
        req.body.start,
        0
      );

      if (start < 0) {
        start = 0;
      }


      /* ----------------------------------------------
      DURATION
      ---------------------------------------------- */

      let duration = safeNumber(
        req.body.duration,
        safeNumber(
          req.body.clipDuration,
          30
        )
      );

      duration = Math.max(
        1,
        Math.min(600, duration)
      );


      console.log(
        "[INPUT]",
        req.file.originalname
      );

      console.log(
        "[SIZE]",
        (req.file.size / 1024 / 1024).toFixed(2),
        "MB"
      );

      console.log(
        "[START]",
        start
      );

      console.log(
        "[DURATION]",
        duration
      );


      /* ----------------------------------------------
      OUTPUT PATH
      ---------------------------------------------- */

      outputPath = path.join(
        os.tmpdir(),
        `reel_${Date.now()}_${Math.random()
          .toString(36)
          .slice(2)}.mp4`
      );


      /* ==================================================
      VIDEO FILTER

      1080 × 1920

      HIGH QUALITY

      force_original_aspect_ratio=increase
      = fills vertical frame

      crop
      = exact 9:16

      lanczos
      = high quality scaling
      ================================================== */

      const filter =
        "scale=1080:1920:" +
        "force_original_aspect_ratio=increase:" +
        "flags=lanczos," +

        "crop=1080:1920," +

        "setsar=1," +

        "format=yuv420p";


      /* ==================================================
      FFMPEG

      IMPORTANT:

      - NO setpts
      - NO atempo

      Therefore:

      ORIGINAL VIDEO SPEED
      ORIGINAL AUDIO SPEED
      ================================================== */

      const args = [

        "-hide_banner",

        "-y",


        /* SEEK */

        "-ss",
        String(start),


        /* INPUT */

        "-i",
        inputPath,


        /* EXACT DURATION */

        "-t",
        String(duration),


        /* VIDEO FILTER */

        "-vf",
        filter,


        /* VIDEO */

        "-map",
        "0:v:0",


        /* AUDIO */

        "-map",
        "0:a:0?",


        /* HIGH QUALITY H264 */

        "-c:v",
        "libx264",


        /* HIGH QUALITY PRESET */

        "-preset",
        "medium",


        /*
        LOWER CRF = BETTER QUALITY

        18 is visually high quality
        */

        "-crf",
        "18",


        /*
        HIGH QUALITY ENCODING PROFILE
        */

        "-profile:v",
        "high",


        "-level:v",
        "4.2",


        /* PIXEL FORMAT */

        "-pix_fmt",
        "yuv420p",


        /*
        VIDEO BITRATE CONTROL

        Prevents very low quality
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
        WEB / PHONE PLAYBACK
        */

        "-movflags",
        "+faststart",


        /* OUTPUT */

        outputPath

      ];


      console.log("");
      console.log("[FFMPEG STARTING]");

      console.log(
        "ffmpeg " +
        args.join(" ")
      );


      /* ==================================================
      RUN FFMPEG
      ================================================== */

      await new Promise(
        (resolve, reject) => {

          const ffmpeg = spawn(
            "ffmpeg",
            args
          );


          let errorOutput = "";


          ffmpeg.stderr.on(
            "data",
            data => {

              const text =
                data.toString();

              errorOutput += text;

              console.log(
                "[FFMPEG]",
                text
              );

            }
          );


          ffmpeg.on(
            "error",
            error => {

              reject(
                new Error(
                  "FFmpeg failed to start: " +
                  error.message
                )
              );

            }
          );


          ffmpeg.on(
            "close",
            code => {

              console.log(
                "[FFMPEG EXIT CODE]",
                code
              );


              if (code === 0) {

                resolve();

              } else {

                reject(
                  new Error(
                    "FFmpeg failed.\n\n" +
                    errorOutput.slice(-5000)
                  )
                );

              }

            }
          );

        }
      );


      /* ==================================================
      CHECK OUTPUT
      ================================================== */

      if (
        !fs.existsSync(outputPath)
      ) {

        throw new Error(
          "Output MP4 was not created."
        );

      }


      const stats =
        fs.statSync(outputPath);


      if (
        !stats.size ||
        stats.size < 1000
      ) {

        throw new Error(
          "Output MP4 is empty or invalid."
        );

      }


      console.log(
        "[SUCCESS] MP4 CREATED"
      );

      console.log(
        "[OUTPUT SIZE]",
        (stats.size / 1024 / 1024).toFixed(2),
        "MB"
      );


      /* ==================================================
      SEND VIDEO
      ================================================== */

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
        'attachment; filename="AI_Reel_1080x1920.mp4"'
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


      const stream =
        fs.createReadStream(outputPath);


      stream.pipe(res);


      stream.on(
        "end",
        () => {

          console.log(
            "[STREAM] VIDEO SENT"
          );

          setTimeout(
            () => {

              cleanup(
                inputPath,
                outputPath
              );

            },
            1000
          );

        }
      );


      stream.on(
        "error",
        error => {

          console.error(
            "[STREAM ERROR]",
            error.message
          );

          cleanup(
            inputPath,
            outputPath
          );

        }
      );


    } catch (error) {

      console.error(
        "[ERROR]",
        error.message
      );

      cleanup(
        inputPath,
        outputPath
      );


      if (!res.headersSent) {

        res.status(500).json({

          error:
            "MP4 creation failed.",

          details:
            error.message

        });

      }

    }

  }
);


/* ==================================================
ERROR HANDLER
================================================== */

app.use(
  (err, req, res, next) => {

    console.error(
      "[SERVER ERROR]",
      err.message
    );


    if (!res.headersSent) {

      res.status(500).json({

        error:
          "Server error",

        details:
          err.message

      });

    }

  }
);


/* ==================================================
START
================================================== */

app.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log("");
    console.log("================================");
    console.log("AI REEL HIGH QUALITY BACKEND");
    console.log("================================");
    console.log("PORT:", PORT);
    console.log("OUTPUT: 1080x1920");
    console.log("RATIO: 9:16");
    console.log("QUALITY: HIGH");
    console.log("VIDEO SPEED: ORIGINAL");
    console.log("AUDIO: ORIGINAL");
    console.log("CRF: 18");
    console.log("PRESET: MEDIUM");
    console.log("================================");
    console.log("");

  }
);
