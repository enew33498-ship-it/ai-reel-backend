const express = require("express");
const multer = require("multer");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

const app = express();

const PORT = process.env.PORT || 10000;


/* ============================================
   SETTINGS
============================================ */

app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Accept"]
}));

app.options("*", cors());

app.use(express.json({
  limit: "10mb"
}));


/* ============================================
   TEMP FOLDER
============================================ */

const uploadDir = path.join(
  os.tmpdir(),
  "ai-reel-uploads"
);

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, {
    recursive: true
  });
}


/* ============================================
   MULTER STORAGE
============================================ */

const storage = multer.diskStorage({

  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },

  filename: (req, file, cb) => {

    const extension =
      path.extname(
        file.originalname || ""
      ) || ".mp4";


    const safeName =
      "input-" +
      Date.now() +
      "-" +
      Math.random()
        .toString(36)
        .slice(2, 10) +
      extension;


    cb(null, safeName);
  }

});


const upload = multer({

  storage,

  limits: {

    fileSize:
      500 * 1024 * 1024

  },

  fileFilter: (req, file, cb) => {

    if (
      file.mimetype &&
      file.mimetype.startsWith("video/")
    ) {

      cb(null, true);

    } else {

      cb(
        new Error(
          "Only video files are allowed."
        )
      );

    }

  }

});


/* ============================================
   HOME
============================================ */

app.get("/", (req, res) => {

  res.status(200).json({

    status: "online",

    service:
      "AI Reel Backend",

    message:
      "AI Reel server is ready",

    ffmpeg:
      "video processing enabled"

  });

});


/* ============================================
   HEALTH CHECK
============================================ */

app.get("/health", (req, res) => {

  res.status(200).json({

    status: "ok",

    timestamp:
      new Date().toISOString()

  });

});


/* ============================================
   CLEANUP FUNCTION
============================================ */

function removeFile(filePath) {

  if (!filePath) {
    return;
  }

  try {

    if (
      fs.existsSync(filePath)
    ) {

      fs.unlinkSync(filePath);

    }

  } catch (error) {

    console.log(
      "[CLEANUP ERROR]",
      error.message
    );

  }

}


/* ============================================
   RUN FFMPEG
============================================ */

function runFFmpeg(args) {

  return new Promise(
    (resolve, reject) => {

      console.log(
        "[FFMPEG START]"
      );


      const ffmpeg =
        spawn(
          "ffmpeg",
          args
        );


      let stderr = "";


      ffmpeg.stdout.on(
        "data",
        data => {

          console.log(
            data.toString()
          );

        }
      );


      ffmpeg.stderr.on(
        "data",
        data => {

          const text =
            data.toString();

          stderr += text;

          console.log(
            text
          );

        }
      );


      ffmpeg.on(
        "error",
        error => {

          reject(
            new Error(
              "Could not start FFmpeg: " +
              error.message
            )
          );

        }
      );


      ffmpeg.on(
        "close",
        code => {

          if (code === 0) {

            console.log(
              "[FFMPEG SUCCESS]"
            );

            resolve();

          } else {

            reject(
              new Error(
                "FFmpeg failed with code " +
                code +
                "\n\n" +
                stderr.slice(-3000)
              )
            );

          }

        }
      );

    }
  );

}


/* ============================================
   CUT VIDEO API
============================================ */

app.post(
  "/cut",

  upload.single("video"),

  async (req, res) => {

    console.log(
      "\n================================"
    );

    console.log(
      "NEW VIDEO REQUEST"
    );

    console.log(
      "================================"
    );


    let inputPath = null;
    let outputPath = null;


    try {

      /* ----------------------------
         CHECK VIDEO
      ---------------------------- */

      if (!req.file) {

        return res.status(400).json({

          error:
            "No video uploaded"

        });

      }


      inputPath =
        req.file.path;


      /* ----------------------------
         GET VALUES
      ---------------------------- */

      const start =
        Number(req.body.start);


      const duration =
        Number(
          req.body.duration ||
          req.body.clipDuration ||
          30
        );


      /* ----------------------------
         VALIDATE
      ---------------------------- */

      if (
        !Number.isFinite(start) ||
        start < 0
      ) {

        throw new Error(
          "Invalid start time."
        );

      }


      if (
        !Number.isFinite(duration) ||
        duration < 5 ||
        duration > 600
      ) {

        throw new Error(
          "Duration must be between 5 and 600 seconds."
        );

      }


      console.log(
        "[VIDEO]",
        req.file.originalname
      );


      console.log(
        "[SIZE]",
        (
          req.file.size /
          1024 /
          1024
        ).toFixed(2) +
        " MB"
      );


      console.log(
        "[START]",
        start.toFixed(2) +
        " seconds"
      );


      console.log(
        "[DURATION]",
        duration +
        " seconds"
      );


      /* ----------------------------
         OUTPUT PATH
      ---------------------------- */

      outputPath = path.join(

        os.tmpdir(),

        "AI-Reel-" +
        Date.now() +
        "-" +
        Math.random()
          .toString(36)
          .slice(2, 10) +
        ".mp4"

      );


      /* ========================================
         FFMPEG SETTINGS

         High quality vertical reel
      ======================================== */

      const ffmpegArgs = [

        "-hide_banner",

        "-nostdin",

        "-y",


        /* Faster seeking */

        "-ss",
        String(start),


        "-i",
        inputPath,


        /* Exact duration */

        "-t",
        String(duration),


        /* ====================================
           VIDEO FILTER

           Makes vertical 1080x1920
        ==================================== */

        "-vf",

        [
          "scale=1080:1920:",
          "force_original_aspect_ratio=increase:",
          "flags=lanczos,",
          "crop=1080:1920,",
          "setsar=1"
        ].join(""),


        /* Video */

        "-map",
        "0:v:0",


        /* Audio optional */

        "-map",
        "0:a:0?",


        /* ====================================
           HIGH QUALITY VIDEO
        ==================================== */

        "-c:v",
        "libx264",


        "-preset",
        "veryfast",


        "-crf",
        "17",


        "-profile:v",
        "high",


        "-level:v",
        "4.2",


        "-pix_fmt",
        "yuv420p",


        /* Better browser playback */

        "-movflags",
        "+faststart",


        /* ====================================
           AUDIO
        ==================================== */

        "-c:a",
        "aac",


        "-b:a",
        "192k",


        "-ar",
        "48000",


        /* Output */

        outputPath

      ];


      console.log(
        "\n[FFMPEG COMMAND]"
      );


      console.log(
        "ffmpeg " +
        ffmpegArgs.join(" ")
      );


      /* ========================================
         PROCESS VIDEO
      ======================================== */

      await runFFmpeg(
        ffmpegArgs
      );


      /* ========================================
         CHECK OUTPUT
      ======================================== */

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
        stats.size <= 0
      ) {

        throw new Error(
          "Output MP4 is empty."
        );

      }


      console.log(
        "\n================================"
      );

      console.log(
        "MP4 CREATED SUCCESSFULLY"
      );

      console.log(
        "================================"
      );


      console.log(
        "[OUTPUT SIZE]",
        (
          stats.size /
          1024 /
          1024
        ).toFixed(2) +
        " MB"
      );


      /* ========================================
         RESPONSE HEADERS
      ======================================== */

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


      /* ========================================
         SEND MP4
      ======================================== */

      const stream =
        fs.createReadStream(
          outputPath
        );


      stream.pipe(res);


      stream.on(
        "error",
        error => {

          console.error(
            "[STREAM ERROR]",
            error.message
          );

          if (!res.headersSent) {

            res.status(500).json({

              error:
                "Failed to send MP4"

            });

          }

        }
      );


      /* Cleanup after response */

      res.on(
        "finish",
        () => {

          console.log(
            "[RESPONSE SUCCESS]"
          );


          setTimeout(
            () => {

              removeFile(inputPath);

              removeFile(outputPath);

            },
            5000
          );

        }
      );


      res.on(
        "close",
        () => {

          setTimeout(
            () => {

              removeFile(inputPath);

              removeFile(outputPath);

            },
            10000
          );

        }
      );


    } catch (error) {

      console.error(
        "\n[CUT ERROR]"
      );

      console.error(
        error.message
      );


      removeFile(inputPath);

      removeFile(outputPath);


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


/* ============================================
   MULTER / SERVER ERROR HANDLER
============================================ */

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


    if (
      error instanceof multer.MulterError
    ) {

      return res.status(400).json({

        error:
          "Upload failed",

        details:
          error.message

      });

    }


    res.status(500).json({

      error:
        "Server error",

      details:
        error.message

    });

  }
);


/* ============================================
   START SERVER
============================================ */

const server =
  app.listen(

    PORT,

    "0.0.0.0",

    () => {

      console.log(
        "\n================================"
      );

      console.log(
        "AI REEL BACKEND ONLINE"
      );

      console.log(
        "================================"
      );

      console.log(
        "PORT:",
        PORT
      );

      console.log(
        "OUTPUT:",
        "1080x1920"
      );

      console.log(
        "RATIO:",
        "9:16"
      );

      console.log(
        "QUALITY:",
        "HIGH"
      );

      console.log(
        "CRF:",
        "17"
      );

      console.log(
        "UPLOAD LIMIT:",
        "500 MB"
      );

      console.log(
        "================================\n"
      );

    }

  );


/* ============================================
   LONG VIDEO PROCESSING
============================================ */

server.timeout = 0;

server.requestTimeout = 0;

server.keepAliveTimeout = 120000;
