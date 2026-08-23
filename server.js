const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const app = express();

const PORT = process.env.PORT || 10000;

const upload = multer({
  dest: "/tmp/uploads"
});

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "AI Reel FFmpeg Backend"
  });
});

app.post("/cut", upload.single("video"), (req, res) => {

  if (!req.file) {
    return res.status(400).json({
      error: "No video uploaded"
    });
  }

  const start =
    Number(req.body.start || 0);

  const input =
    req.file.path;

  const output =
    path.join(
      "/tmp",
      `reel_${Date.now()}.mp4`
    );

  if (!Number.isFinite(start) || start < 0) {

    fs.unlink(input, () => {});

    return res.status(400).json({
      error: "Invalid start time"
    });

  }

  const args = [
    "-ss",
    String(start),

    "-i",
    input,

    "-t",
    "30",

    "-map",
    "0:v:0",

    "-map",
    "0:a?",

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

    "-y",

    output
  ];

  execFile(
    "ffmpeg",
    args,
    {
      maxBuffer: 1024 * 1024 * 20
    },
    (error, stdout, stderr) => {

      fs.unlink(input, () => {});

      if (error) {

        console.error(stderr);

        if (fs.existsSync(output)) {
          fs.unlink(output, () => {});
        }

        return res.status(500).json({
          error: "FFmpeg failed",
          details: stderr
        });

      }

      res.download(
        output,
        "AI_Reel_Best_30_Seconds.mp4",
        () => {

          fs.unlink(
            output,
            () => {}
          );

        }
      );

    }
  );

});

app.listen(PORT, () => {

  console.log(
    `AI Reel backend running on port ${PORT}`
  );

});
