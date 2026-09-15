/*
========================================================
 AI REEL EDITOR
 MOVEMENT ENGINE MAX V1
========================================================

PURPOSE
-------
Visual movement analysis only.

THIS ENGINE:
- DOES NOT CREATE MP4
- DOES NOT MODIFY ORIGINAL VIDEO
- DOES NOT TOUCH /cut
- DOES NOT TOUCH EXISTING VOICE ENGINE
- ONLY ANALYZES VISUAL MOVEMENT

PIPELINE
--------

VIDEO
  ↓
FFmpeg low-resolution analysis stream
  ↓
Frame difference
  ↓
Motion intensity
  ↓
Motion peaks
  ↓
Motion acceleration
  ↓
Motion stability
  ↓
Scene-change detection
  ↓
30-second candidate windows
  ↓
TOP 10
  ↓
BEST MOVEMENT MOMENT

========================================================
*/

"use strict";


/* ======================================================
   IMPORTS
====================================================== */

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");


/* ======================================================
   CONFIG
====================================================== */

/*
Low-resolution analysis keeps Render CPU usage
reasonable while still preserving movement information.
*/

const ANALYSIS_WIDTH = 320;

const ANALYSIS_HEIGHT = 180;


/*
Frames analyzed per second.

Higher = more detail.
Lower = less CPU.

5 FPS is a good balance.
*/

const ANALYSIS_FPS = 5;


/*
30 second reel target.
*/

const CLIP_DURATION = 30;


/*
Candidate window step.

1 second means we test:

0-30
1-31
2-32
3-33
...

This gives good precision.
*/

const WINDOW_STEP = 1;


/*
Scene change threshold.

This is intentionally conservative.
*/

const SCENE_CHANGE_THRESHOLD = 0.35;


/*
Maximum number of returned candidates.
*/

const TOP_LIMIT = 10;


/*
Minimum distance between top candidates.
*/

const SEPARATION_SECONDS = 5;


/*
Maximum number of raw frames kept in memory.

The engine does NOT need to keep the whole video.
*/

const MAX_ANALYSIS_FRAMES = 200000;


/* ======================================================
   SAFE NUMBER
====================================================== */

function safeNumber(
  value,
  fallback = 0
) {

  const n =
    Number(value);

  if (
    !Number.isFinite(n)
  ) {

    return fallback;

  }

  return n;

}


/* ======================================================
   CLAMP
====================================================== */

function clamp(
  value,
  min = 0,
  max = 1
) {

  return Math.min(
    max,
    Math.max(
      min,
      safeNumber(value)
    )
  );

}


/* ======================================================
   ROUND
====================================================== */

function round(
  value,
  digits = 4
) {

  const factor =
    Math.pow(
      10,
      digits
    );

  return Math.round(
    safeNumber(value) *
      factor
  ) / factor;

}


/* ======================================================
   RUN COMMAND
====================================================== */

function runCommand(
  command,
  args = []
) {

  return new Promise(
    (resolve, reject) => {

      const child =
        spawn(
          command,
          args,
          {
            stdio: [
              "ignore",
              "pipe",
              "pipe"
            ]
          }
        );


      let stdout = "";

      let stderr = "";


      child.stdout.on(
        "data",
        data => {

          stdout +=
            data.toString();

        }
      );


      child.stderr.on(
        "data",
        data => {

          stderr +=
            data.toString();

        }
      );


      child.on(
        "error",
        error => {

          reject(error);

        }
      );


      child.on(
        "close",
        code => {

          if (
            code !== 0
          ) {

            const error =
              new Error(
                `${command} failed with exit code ${code}\n${stderr.slice(-6000)}`
              );

            error.code =
              code;

            error.stderr =
              stderr;

            error.stdout =
              stdout;

            reject(
              error
            );

            return;

          }


          resolve({

            stdout,

            stderr

          });

        }
      );

    }
  );

}


/* ======================================================
   GET VIDEO INFORMATION
====================================================== */

async function getVideoInfo(
  videoPath
) {

  const result =
    await runCommand(
      "ffprobe",
      [
        "-v",
        "error",

        "-show_entries",
        "format=duration",

        "-of",
        "default=noprint_wrappers=1:nokey=1",

        videoPath
      ]
    );


  const duration =
    safeNumber(
      result.stdout.trim()
    );


  if (
    duration <= 0
  ) {

    throw new Error(
      "Could not determine video duration."
    );

  }


  return {

    duration

  };

}


/* ======================================================
   FRAME DIFFERENCE
====================================================== */

/*
Calculate visual difference between two grayscale frames.

The frames are raw gray8 data.

Result:
0 = almost identical
1 = very large visual change
*/

function calculateFrameDifference(
  previous,
  current
) {

  if (
    !previous ||
    !current ||
    previous.length !==
      current.length
  ) {

    return 0;

  }


  let total = 0;

  const length =
    current.length;


  /*
  Sampling every few pixels reduces CPU
  while preserving global movement.
  */

  const stride = 4;


  let count = 0;


  for (
    let i = 0;
    i < length;
    i += stride
  ) {

    total +=
      Math.abs(
        current[i] -
        previous[i]
      );


    count++;

  }


  if (
    count === 0
  ) {

    return 0;

  }


  /*
  Pixel difference range = 0..255

  Normalize to 0..1
  */

  return clamp(
    (
      total /
      count
    ) / 255
  );

}


/* ======================================================
   SMOOTH VALUES
====================================================== */

function smoothValues(
  values,
  radius = 2
) {

  if (
    values.length === 0
  ) {

    return [];

  }


  const output =
    new Array(
      values.length
    );


  for (
    let i = 0;
    i < values.length;
    i++
  ) {

    let total = 0;

    let count = 0;


    const start =
      Math.max(
        0,
        i - radius
      );


    const end =
      Math.min(
        values.length - 1,
        i + radius
      );


    for (
      let j = start;
      j <= end;
      j++
    ) {

      total +=
        values[j];

      count++;

    }


    output[i] =
      count > 0
        ? total / count
        : 0;

  }


  return output;

}


/* ======================================================
   NORMALIZE MOTION
====================================================== */

function normalizeMotion(
  values
) {

  if (
    values.length === 0
  ) {

    return [];

  }


  /*
  Robust normalization.

  We use the 90th percentile rather than
  the absolute maximum so one unusual frame
  does not distort the entire video.
  */

  const sorted =
    [...values].sort(
      (a, b) =>
        a - b
    );


  const index =
    Math.floor(
      sorted.length *
      0.90
    );


  const reference =
    Math.max(
      0.0001,
      sorted[
        Math.min(
          index,
          sorted.length - 1
        )
      ]
    );


  return values.map(
    value =>
      clamp(
        value /
        reference
      )
  );

}


/* ======================================================
   CALCULATE PEAK
====================================================== */

function calculatePeak(
  values
) {

  if (
    values.length === 0
  ) {

    return 0;

  }


  let peak = 0;


  for (
    const value of values
  ) {

    peak =
      Math.max(
        peak,
        clamp(value)
      );

  }


  return peak;

}


/* ======================================================
   CALCULATE AVERAGE
====================================================== */

function calculateAverage(
  values
) {

  if (
    values.length === 0
  ) {

    return 0;

  }


  const total =
    values.reduce(
      (
        sum,
        value
      ) =>
        sum + value,
      0
    );


  return clamp(
    total /
    values.length
  );

}


/* ======================================================
   CALCULATE VARIANCE
====================================================== */

function calculateVariance(
  values
) {

  if (
    values.length < 2
  ) {

    return 0;

  }


  const mean =
    calculateAverage(
      values
    );


  let total = 0;


  for (
    const value of
    values
  ) {

    total +=
      Math.pow(
        value - mean,
        2
      );

  }


  return total /
    values.length;

}


/* ======================================================
   MOTION STABILITY
====================================================== */

function calculateMotionStability(
  values
) {

  if (
    values.length === 0
  ) {

    return 0;

  }


  const variance =
    calculateVariance(
      values
    );


  /*
  Higher stability when movement
  doesn't fluctuate wildly.
  */

  return clamp(
    1 -
    Math.sqrt(
      variance
    )
  );

}


/* ======================================================
   MOTION ACCELERATION
====================================================== */

function calculateMotionAcceleration(
  values
) {

  if (
    values.length < 2
  ) {

    return 0;

  }


  let total = 0;

  let count = 0;


  for (
    let i = 1;
    i < values.length;
    i++
  ) {

    total +=
      Math.abs(
        values[i] -
        values[i - 1]
      );


    count++;

  }


  if (
    count === 0
  ) {

    return 0;

  }


  return clamp(
    total /
    count
  );

}


/* ======================================================
   MOTION MOMENTUM
====================================================== */

function calculateMomentum(
  values
) {

  if (
    values.length < 3
  ) {

    return 0;

  }


  let rising = 0;

  let count = 0;


  for (
    let i = 2;
    i < values.length;
    i++
  ) {

    const previous =
      values[i - 1];


    const current =
      values[i];


    const before =
      values[i - 2];


    const firstDelta =
      previous -
      before;


    const secondDelta =
      current -
      previous;


    if (
      firstDelta > 0 &&
      secondDelta > 0
    ) {

      rising++;

    }


    count++;

  }


  return count > 0
    ? rising / count
    : 0;

}


/* ======================================================
   FIND PEAKS
====================================================== */

function findMotionPeaks(
  values,
  threshold = 0.70
) {

  const peaks = [];


  if (
    values.length < 3
  ) {

    return peaks;

  }


  for (
    let i = 1;
    i <
      values.length - 1;
    i++
  ) {

    const current =
      values[i];


    if (
      current <
      threshold
    ) {

      continue;

    }


    const previous =
      values[i - 1];


    const next =
      values[i + 1];


    if (
      current >= previous &&
      current >= next
    ) {

      peaks.push({

        index:
          i,

        value:
          current

      });

    }

  }


  return peaks;

}


/* ======================================================
   DETECT SCENE CHANGES
====================================================== */

function detectSceneChanges(
  motionValues
) {

  const changes = [];


  if (
    motionValues.length < 3
  ) {

    return changes;

  }


  for (
    let i = 1;
    i <
      motionValues.length;
    i++
  ) {

    const current =
      motionValues[i];


    const previous =
      motionValues[i - 1];


    const jump =
      Math.abs(
        current -
        previous
      );


    if (
      jump >=
      SCENE_CHANGE_THRESHOLD
    ) {

      changes.push({

        index:
          i,

        jump:
          round(
            jump
          )

      });

    }

  }


  return changes;

}


/* ======================================================
   READ RAW FRAMES
====================================================== */

/*
FFmpeg outputs gray8 frames directly to stdout.

This avoids writing thousands of temporary image files.
*/

function readFrames(
  videoPath,
  duration,
  progressCallback
) {

  return new Promise(
    (resolve, reject) => {

      const frameSize =
        ANALYSIS_WIDTH *
        ANALYSIS_HEIGHT;


      const args = [

        "-hide_banner",

        "-loglevel",
        "error",

        "-i",
        videoPath,

        "-vf",
        `fps=${ANALYSIS_FPS},scale=${ANALYSIS_WIDTH}:${ANALYSIS_HEIGHT}:flags=fast_bilinear,format=gray`,

        "-f",
        "rawvideo",

        "-pix_fmt",
        "gray",

        "pipe:1"

      ];


      const child =
        spawn(
          "ffmpeg",
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


      const frames = [];


      let buffer =
        Buffer.alloc(0);


      let frameCount = 0;


      child.stderr.on(
        "data",
        data => {

          stderr +=
            data.toString();

        }
      );


      child.stdout.on(
        "data",
        chunk => {

          buffer =
            Buffer.concat([
              buffer,
              chunk
            ]);


          while (
            buffer.length >=
            frameSize
          ) {

            if (
              frameCount >=
              MAX_ANALYSIS_FRAMES
            ) {

              child.kill(
                "SIGTERM"
              );

              break;

            }


            const frame =
              Buffer.from(
                buffer.subarray(
                  0,
                  frameSize
                )
              );


            buffer =
              buffer.subarray(
                frameSize
              );


            frames.push(
              frame
            );


            frameCount++;


            if (
              typeof progressCallback ===
              "function"
            ) {

              const analyzedDuration =
                frameCount /
                ANALYSIS_FPS;


              const percentage =
                duration > 0
                  ? Math.min(
                      65,
                      25 +
                      (
                        analyzedDuration /
                        duration
                      ) *
                      40
                    )
                  : 40;


              progressCallback(
                Math.round(
                  percentage
                )
              );

            }

          }

        }
      );


      child.on(
        "error",
        error => {

          reject(
            error
          );

        }
      );


      child.on(
        "close",
        code => {

          if (
            code !== 0 &&
            code !== 255
          ) {

            const error =
              new Error(
                `FFmpeg frame analysis failed with exit code ${code}\n${stderr.slice(-6000)}`
              );

            error.code =
              code;

            error.stderr =
              stderr;

            reject(
              error
            );

            return;

          }


          resolve(
            frames
          );

        }
      );

    }
  );

}


/* ======================================================
   BUILD MOTION TIMELINE
====================================================== */

function buildMotionTimeline(
  frames
) {

  const rawMotion = [];


  let previous =
    null;


  for (
    let i = 0;
    i < frames.length;
    i++
  ) {

    const current =
      frames[i];


    if (
      previous
    ) {

      rawMotion.push(
        calculateFrameDifference(
          previous,
          current
        )
      );

    } else {

      rawMotion.push(
        0
      );

    }


    previous =
      current;

  }


  const normalized =
    normalizeMotion(
      rawMotion
    );


  const smoothed =
    smoothValues(
      normalized,
      2
    );


  const timeline = [];


  for (
    let i = 0;
    i < smoothed.length;
    i++
  ) {

    timeline.push({

      time:
        round(
          i /
          ANALYSIS_FPS,
          3
        ),

      rawMotion:
        round(
          rawMotion[i],
          5
        ),

      motion:
        round(
          smoothed[i],
          4
        )

    });

  }


  return timeline;

}


/* ======================================================
   GET WINDOW VALUES
====================================================== */

function getWindowValues(
  timeline,
  start,
  end
) {

  const values = [];


  for (
    const item of
    timeline
  ) {

    if (
      item.time <
      start
    ) {

      continue;

    }


    if (
      item.time >=
      end
    ) {

      break;

    }


    values.push(
      item.motion
    );

  }


  return values;

}


/* ======================================================
   WINDOW SCENE CHANGES
====================================================== */

function getWindowSceneChanges(
  sceneChanges,
  start,
  end
) {

  const result = [];


  for (
    const change of
    sceneChanges
  ) {

    const time =
      change.index /
      ANALYSIS_FPS;


    if (
      time <
      start
    ) {

      continue;

    }


    if (
      time >=
      end
    ) {

      break;

    }


    result.push({

      time:
        round(
          time
        ),

      jump:
        change.jump

    });

  }


  return result;

}


/* ======================================================
   SCORE MOVEMENT WINDOW
====================================================== */

function scoreMovementWindow(
  start,
  end,
  timeline,
  sceneChanges
) {

  const values =
    getWindowValues(
      timeline,
      start,
      end
    );


  if (
    values.length === 0
  ) {

    return null;

  }


  const averageMotion =
    calculateAverage(
      values
    );


  const peakMotion =
    calculatePeak(
      values
    );


  const acceleration =
    calculateMotionAcceleration(
      values
    );


  const momentum =
    calculateMomentum(
      values
    );


  const stability =
    calculateMotionStability(
      values
    );


  const windowChanges =
    getWindowSceneChanges(
      sceneChanges,
      start,
      end
    );


  const sceneChangeCount =
    windowChanges.length;


  /*
  ------------------------------------------------------
  MOVEMENT SCORE

  Average movement       35
  Peak movement          25
  Momentum               12
  Acceleration             8
  Scene changes            8
  Stability                7
  Activity floor           5
  ------------------------------------------------------

  TOTAL = 100
  ------------------------------------------------------
  */


  const averageScore =
    averageMotion *
    35;


  const peakScore =
    peakMotion *
    25;


  const momentumScore =
    momentum *
    12;


  const accelerationScore =
    clamp(
      acceleration * 3
    ) *
    8;


  /*
  A few scene changes are useful.

  Too many cuts should not dominate.
  */

  let sceneQuality = 0;


  if (
    sceneChangeCount === 0
  ) {

    sceneQuality = 0.25;

  } else if (
    sceneChangeCount <= 2
  ) {

    sceneQuality = 1;

  } else if (
    sceneChangeCount <= 5
  ) {

    sceneQuality = 0.85;

  } else if (
    sceneChangeCount <= 10
  ) {

    sceneQuality = 0.60;

  } else {

    sceneQuality = 0.35;

  }


  const sceneScore =
    sceneQuality *
    8;


  const stabilityScore =
    stability *
    7;


  /*
  Activity floor prevents completely
  static windows from receiving a
  high score from one isolated peak.
  */

  const activityFloor =
    averageMotion >= 0.15
      ? 1
      : averageMotion >= 0.08
        ? 0.60
        : averageMotion >= 0.03
          ? 0.30
          : 0;


  const floorScore =
    activityFloor *
    5;


  const score =
    averageScore +
    peakScore +
    momentumScore +
    accelerationScore +
    sceneScore +
    stabilityScore +
    floorScore;


  return {

    start:
      round(
        start
      ),

    end:
      round(
        end
      ),

    duration:
      round(
        end -
        start
      ),

    averageMotion:
      round(
        averageMotion
      ),

    peakMotion:
      round(
        peakMotion
      ),

    motionAcceleration:
      round(
        acceleration
      ),

    motionMomentum:
      round(
        momentum
      ),

    motionStability:
      round(
        stability
      ),

    sceneChanges:
      sceneChangeCount,

    sceneChangeStrength:
      round(
        windowChanges.reduce(
          (
            sum,
            item
          ) =>
            sum +
            item.jump,
          0
        )
      ),

    score:
      round(
        clamp(
          score /
          100
        ) *
        100,
        2
      )

  };

}


/* ======================================================
   CREATE CANDIDATES
====================================================== */

function createMovementCandidates(
  timeline,
  sceneChanges,
  duration
) {

  const candidates = [];


  const clipLength =
    Math.min(
      CLIP_DURATION,
      duration
    );


  const maxStart =
    Math.max(
      0,
      duration -
      clipLength
    );


  for (
    let start = 0;
    start <= maxStart;
    start += WINDOW_STEP
  ) {

    const end =
      Math.min(
        duration,
        start +
        clipLength
      );


    const candidate =
      scoreMovementWindow(
        start,
        end,
        timeline,
        sceneChanges
      );


    if (
      candidate
    ) {

      candidates.push(
        candidate
      );

    }

  }


  /*
  Always test final possible window.
  */

  if (
    maxStart > 0
  ) {

    const exists =
      candidates.some(
        candidate =>
          Math.abs(
            candidate.start -
            maxStart
          ) <
          0.001
      );


    if (
      !exists
    ) {

      const candidate =
        scoreMovementWindow(
          maxStart,
          maxStart +
          clipLength,
          timeline,
          sceneChanges
        );


      if (
        candidate
      ) {

        candidates.push(
          candidate
        );

      }

    }

  }


  return candidates;

}


/* ======================================================
   TOP SEPARATED
====================================================== */

function getTopSeparated(
  candidates,
  limit = TOP_LIMIT,
  separation =
    SEPARATION_SECONDS
) {

  const sorted =
    [...candidates].sort(
      (a, b) =>
        b.score -
        a.score
    );


  const selected = [];


  for (
    const candidate of
    sorted
  ) {

    const tooClose =
      selected.some(
        existing =>
          Math.abs(
            candidate.start -
            existing.start
          ) <
          separation
      );


    if (
      tooClose
    ) {

      continue;

    }


    selected.push(
      candidate
    );


    if (
      selected.length >=
      limit
    ) {

      break;

    }

  }


  return selected;

}


/* ======================================================
   ANALYZE MOVEMENT
====================================================== */

async function analyzeMovement(
  videoPath,
  duration,
  progressCallback
) {

  const videoDuration =
    Math.max(
      0,
      safeNumber(
        duration
      )
    );


  console.log("");
  console.log(
    "======================================================"
  );

  console.log(
    "🎬 MOVEMENT ENGINE MAX V1"
  );

  console.log(
    "VISUAL MOTION ANALYSIS"
  );

  console.log(
    "DURATION:",
    videoDuration,
    "seconds"
  );

  console.log(
    "======================================================"
  );


  if (
    videoDuration <= 0
  ) {

    throw new Error(
      "Invalid video duration."
    );

  }


  if (
    typeof progressCallback ===
    "function"
  ) {

    progressCallback(
      5
    );

  }


  /*
  ======================================================
  STEP 1
  GET VIDEO INFO
  ======================================================
  */

  await getVideoInfo(
    videoPath
  );


  if (
    typeof progressCallback ===
    "function"
  ) {

    progressCallback(
      15
    );

  }


  /*
  ======================================================
  STEP 2
  READ LOW-RESOLUTION FRAMES
  ======================================================
  */

  const frames =
    await readFrames(
      videoPath,
      videoDuration,
      progressCallback
    );


  console.log(
    "[MOVEMENT MAX] FRAMES:",
    frames.length
  );


  if (
    frames.length < 2
  ) {

    throw new Error(
      "Not enough frames for movement analysis."
    );

  }


  /*
  ======================================================
  STEP 3
  BUILD MOTION TIMELINE
  ======================================================
  */

  const timeline =
    buildMotionTimeline(
      frames
    );


  /*
  Frames are no longer required after
  timeline creation.

  This allows garbage collection.
  */

  /*
  ======================================================
  STEP 4
  GLOBAL MOTION DATA
  ======================================================
  */

  const motionValues =
    timeline.map(
      item =>
        item.motion
    );


  const globalAverage =
    calculateAverage(
      motionValues
    );


  const globalPeak =
    calculatePeak(
      motionValues
    );


  const globalAcceleration =
    calculateMotionAcceleration(
      motionValues
    );


  const globalStability =
    calculateMotionStability(
      motionValues
    );


  /*
  ======================================================
  STEP 5
  MOTION PEAKS
  ======================================================
  */

  const peakIndexes =
    findMotionPeaks(
      motionValues,
      0.70
    );


  const motionPeaks =
    peakIndexes.map(
      peak => ({

        time:
          round(
            peak.index /
            ANALYSIS_FPS
          ),

        motion:
          round(
            peak.value
          )

      })
    );


  /*
  ======================================================
  STEP 6
  SCENE CHANGES
  ======================================================
  */

  const sceneChanges =
    detectSceneChanges(
      motionValues
    );


  const sceneChangeList =
    sceneChanges.map(
      item => ({

        time:
          round(
            item.index /
            ANALYSIS_FPS
          ),

        strength:
          item.jump

      })
    );


  if (
    typeof progressCallback ===
    "function"
  ) {

    progressCallback(
      75
    );

  }


  /*
  ======================================================
  STEP 7
  30 SECOND CANDIDATES
  ======================================================
  */

  const candidates =
    createMovementCandidates(
      timeline,
      sceneChanges,
      videoDuration
    );


  console.log(
    "[MOVEMENT MAX] CANDIDATES:",
    candidates.length
  );


  /*
  ======================================================
  STEP 8
  TOP RESULTS
  ======================================================
  */

  const top =
    getTopSeparated(
      candidates,
      TOP_LIMIT,
      SEPARATION_SECONDS
    );


  /*
  ======================================================
  STEP 9
  BEST
  ======================================================
  */

  let best =
    null;


  if (
    top.length > 0
  ) {

    best =
      top[0];

  } else if (
    candidates.length > 0
  ) {

    best =
      [...candidates].sort(
        (a, b) =>
          b.score -
          a.score
      )[0];

  }


  if (
    typeof progressCallback ===
    "function"
  ) {

    progressCallback(
      100
    );

  }


  console.log("");
  console.log(
    "======================================================"
  );

  console.log(
    "🎬 MOVEMENT ENGINE MAX COMPLETE"
  );

  console.log(
    "GLOBAL AVERAGE:",
    round(
      globalAverage
    )
  );

  console.log(
    "GLOBAL PEAK:",
    round(
      globalPeak
    )
  );

  console.log(
    "MOTION PEAKS:",
    motionPeaks.length
  );

  console.log(
    "SCENE CHANGES:",
    sceneChangeList.length
  );

  console.log(
    "CANDIDATES:",
    candidates.length
  );


  if (
    best
  ) {

    console.log(
      "BEST:",
      best.start,
      "->",
      best.end,
      "SCORE:",
      best.score
    );

  }


  console.log(
    "======================================================"
  );


  /*
  ======================================================
  RETURN
  ======================================================
  */

  return {

    engine:
      "Movement Engine MAX V1",

    detector:
      "FFmpeg frame-difference motion analysis",

    duration:
      round(
        videoDuration
      ),

    analysis: {

      width:
        ANALYSIS_WIDTH,

      height:
        ANALYSIS_HEIGHT,

      fps:
        ANALYSIS_FPS,

      frames:
        frames.length

    },

    global: {

      averageMotion:
        round(
          globalAverage
        ),

      peakMotion:
        round(
          globalPeak
        ),

      motionAcceleration:
        round(
          globalAcceleration
        ),

      motionStability:
        round(
          globalStability
        )

    },

    motionPeaks:
      motionPeaks.slice(
        0,
        100
      ),

    motionPeakCount:
      motionPeaks.length,

    sceneChanges:
      sceneChangeList.slice(
        0,
        200
      ),

    sceneChangeCount:
      sceneChangeList.length,

    candidatesAnalyzed:
      candidates.length,

    top,

    best,

    settings: {

      analysisWidth:
        ANALYSIS_WIDTH,

      analysisHeight:
        ANALYSIS_HEIGHT,

      analysisFPS:
        ANALYSIS_FPS,

      clipDuration:
        CLIP_DURATION,

      windowStep:
        WINDOW_STEP,

      sceneChangeThreshold:
        SCENE_CHANGE_THRESHOLD,

      topLimit:
        TOP_LIMIT,

      separationSeconds:
        SEPARATION_SECONDS

    }

  };

}


/* ======================================================
   EXPORTS
====================================================== */

module.exports = {

  analyzeMovement,

  createMovementCandidates,

  getTopSeparated,

  calculateFrameDifference,

  calculateMotionAcceleration,

  calculateMotionStability,

  detectSceneChanges

};
