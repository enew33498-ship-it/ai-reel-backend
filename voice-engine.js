/*
=========================================================
 VOICE ENGINE — STANDALONE
 AI REEL EDITOR
=========================================================

Purpose:
- Video ke audio track ko analyze karna
- Silence detect karna
- Audio activity detect karna
- Loudness/energy measure karna
- Voice/activity ke candidate timestamps banana

IMPORTANT:
Ye module abhi standalone hai.
Server.js mein abhi attach nahi kiya gaya hai.
=========================================================
*/

const { spawn } = require("child_process");

/*
=========================================================
 RUN FFMPEG
=========================================================
*/

function runFFmpeg(args) {

  return new Promise((resolve, reject) => {

    const ffmpeg = spawn("ffmpeg", args);

    let stdout = "";
    let stderr = "";

    ffmpeg.stdout.on("data", data => {
      stdout += data.toString();
    });

    ffmpeg.stderr.on("data", data => {
      stderr += data.toString();
    });

    ffmpeg.on("error", error => {
      reject(error);
    });

    ffmpeg.on("close", code => {

      if (code !== 0) {

        reject(
          new Error(
            "FFmpeg failed with code " +
            code +
            "\n" +
            stderr.slice(-3000)
          )
        );

        return;
      }

      resolve({
        stdout,
        stderr
      });
    });
  });
}


/*
=========================================================
 GET AUDIO INFORMATION
=========================================================
*/

async function getAudioInfo(videoPath) {

  const result = await runFFmpeg([
    "-hide_banner",
    "-i",
    videoPath,
    "-vn",
    "-af",
    "volumedetect",
    "-f",
    "null",
    "-"
  ]);

  const text = result.stderr;

  const meanMatch =
    text.match(/mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/i);

  const maxMatch =
    text.match(/max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/i);

  const meanVolume =
    meanMatch
      ? parseFloat(meanMatch[1])
      : null;

  const maxVolume =
    maxMatch
      ? parseFloat(maxMatch[1])
      : null;

  return {
    meanVolume,
    maxVolume
  };
}


/*
=========================================================
 SILENCE / AUDIO ACTIVITY DETECTOR
=========================================================

silencedetect:
- silence_start
- silence_end

Non-silent areas are treated as
VOICE CANDIDATE areas.

NOTE:
Music/noise can also be non-silent.
Actual speech recognition will be added
later as a separate stronger layer.
=========================================================
*/

async function detectAudioActivity(
  videoPath,
  noiseDb = -35,
  minSilence = 0.35
) {

  const filter =
    "silencedetect=" +
    "noise=" +
    noiseDb +
    "dB:" +
    "d=" +
    minSilence;

  const result = await runFFmpeg([
    "-hide_banner",
    "-i",
    videoPath,
    "-vn",
    "-af",
    filter,
    "-f",
    "null",
    "-"
  ]);

  const text = result.stderr;

  const events = [];

  const lines =
    text.split(/\r?\n/);

  for (const line of lines) {

    const startMatch =
      line.match(
        /silence_start:\s*(-?\d+(?:\.\d+)?)/
      );

    if (startMatch) {

      events.push({
        type: "silence_start",
        time: parseFloat(startMatch[1])
      });

      continue;
    }

    const endMatch =
      line.match(
        /silence_end:\s*(-?\d+(?:\.\d+)?)/
      );

    if (endMatch) {

      events.push({
        type: "silence_end",
        time: parseFloat(endMatch[1])
      });
    }
  }

  return events;
}


/*
=========================================================
 BUILD ACTIVE AUDIO SEGMENTS
=========================================================
*/

function buildActiveSegments(
  events,
  duration
) {

  const segments = [];

  let silenceStart = null;

  for (const event of events) {

    if (
      event.type ===
      "silence_start"
    ) {

      silenceStart =
        event.time;

      continue;
    }

    if (
      event.type ===
        "silence_end" &&
      silenceStart !== null
    ) {

      const silenceEnd =
        event.time;

      if (silenceStart > 0) {

        segments.push({
          start: 0,
          end: silenceStart
        });
      }

      /*
        Store next active section.
      */

      segments.push({
        start: silenceEnd,
        end: null
      });

      silenceStart = null;
    }
  }


  /*
  =======================================================
   FIX SEGMENT END TIMES
  =======================================================
  */

  const fixed = [];

  for (let i = 0; i < segments.length; i++) {

    const segment =
      segments[i];

    if (segment.end !== null) {

      fixed.push(segment);

      continue;
    }

    let nextStart = null;

    for (
      let j = i + 1;
      j < segments.length;
      j++
    ) {

      if (
        segments[j].start !== undefined
      ) {

        nextStart =
          segments[j].start;

        break;
      }
    }

    fixed.push({
      start: segment.start,
      end:
        nextStart !== null
          ? nextStart
          : duration
    });
  }


  /*
  =======================================================
   MERGE OVERLAPPING SEGMENTS
  =======================================================
  */

  fixed.sort(
    (a, b) =>
      a.start - b.start
  );

  const merged = [];

  for (const segment of fixed) {

    if (
      segment.end <=
      segment.start
    ) {
      continue;
    }

    const last =
      merged[merged.length - 1];

    if (
      last &&
      segment.start <=
      last.end + 0.25
    ) {

      last.end =
        Math.max(
          last.end,
          segment.end
        );

    } else {

      merged.push({
        start: segment.start,
        end: segment.end
      });
    }
  }

  return merged;
}


/*
=========================================================
 CREATE 30 SECOND VOICE CANDIDATES
=========================================================
*/

function createVoiceCandidates(
  segments,
  duration
) {

  const results = [];

  const windowSize = 30;

  for (
    let start = 0;
    start <= duration - windowSize;
    start += 5
  ) {

    const end =
      start + windowSize;

    let activeTime = 0;

    for (const segment of segments) {

      const overlapStart =
        Math.max(
          start,
          segment.start
        );

      const overlapEnd =
        Math.min(
          end,
          segment.end
        );

      if (
        overlapEnd >
        overlapStart
      ) {

        activeTime +=
          overlapEnd -
          overlapStart;
      }
    }

    /*
    =========================================
     VOICE / AUDIO ACTIVITY PERCENTAGE
    =========================================
    */

    const activityPercent =
      Math.min(
        100,
        (activeTime /
          windowSize) *
          100
      );

    /*
    =========================================
     SCORE
    =========================================
    */

    let score =
      activityPercent;

    /*
      Prefer clips that contain
      meaningful active audio but
      aren't completely noisy.
    */

    if (
      activityPercent >= 35 &&
      activityPercent <= 95
    ) {

      score += 5;
    }

    if (
      activityPercent < 10
    ) {

      score *= 0.25;
    }

    if (
      activityPercent > 99
    ) {

      score *= 0.90;
    }

    results.push({

      start,

      end,

      activeTime,

      activityPercent,

      score
    });
  }


  /*
  =========================================
   SORT BEST FIRST
  =========================================
  */

  results.sort(
    (a, b) =>
      b.score - a.score
  );

  return results;
}


/*
=========================================================
 MAIN VOICE ENGINE
=========================================================
*/

async function analyzeVoice(
  videoPath,
  duration
) {

  if (!videoPath) {

    throw new Error(
      "Voice Engine: videoPath is required."
    );
  }

  if (
    !duration ||
    duration <= 0
  ) {

    throw new Error(
      "Voice Engine: valid video duration is required."
    );
  }


  console.log(
    "🎙️ VOICE ENGINE STARTED"
  );

  console.log(
    "🎙️ Video:",
    videoPath
  );

  console.log(
    "⏱ Duration:",
    duration
  );


  /*
  =========================================
   AUDIO INFORMATION
  =========================================
  */

  const audioInfo =
    await getAudioInfo(
      videoPath
    );

  console.log(
    "🔊 Mean volume:",
    audioInfo.meanVolume
  );

  console.log(
    "🔊 Max volume:",
    audioInfo.maxVolume
  );


  /*
  =========================================
   DETECT SILENCE
  =========================================
  */

  console.log(
    "🔎 Detecting voice/audio activity..."
  );

  const events =
    await detectAudioActivity(
      videoPath
    );


  /*
  =========================================
   BUILD ACTIVE SEGMENTS
  =========================================
  */

  const activeSegments =
    buildActiveSegments(
      events,
      duration
    );


  console.log(
    "🎙️ Active segments:",
    activeSegments.length
  );


  /*
  =========================================
   30 SECOND CANDIDATES
  =========================================
  */

  const candidates =
    createVoiceCandidates(
      activeSegments,
      duration
    );


  /*
  =========================================
   TOP 10
  =========================================
  */

  const top10 =
    candidates.slice(0, 10);


  console.log(
    "🔥 TOP VOICE CANDIDATES"
  );

  top10.forEach(
    (item, index) => {

      console.log(
        "#" +
        (index + 1) +
        " | " +
        item.start.toFixed(1) +
        "s → " +
        item.end.toFixed(1) +
        "s" +
        " | Active: " +
        item.activityPercent.toFixed(1) +
        "%" +
        " | Score: " +
        item.score.toFixed(1)
      );
    }
  );


  /*
  =========================================
   FINAL RESULT
  =========================================
  */

  const result = {

    engine:
      "VOICE_ENGINE",

    version:
      "1.0",

    audio: {

      meanVolume:
        audioInfo.meanVolume,

      maxVolume:
        audioInfo.maxVolume
    },

    activeSegments,

    candidates,

    top10
  };


  console.log(
    "✅ VOICE ENGINE COMPLETE"
  );


  return result;
}


/*
=========================================================
 EXPORT
=========================================================
*/

module.exports = {

  analyzeVoice,

  getAudioInfo,

  detectAudioActivity,

  buildActiveSegments,

  createVoiceCandidates

};
