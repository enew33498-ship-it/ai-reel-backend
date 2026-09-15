"use strict";

/*
=========================================================
 MOVEMENT ENGINE MAX V3
 =========================================================

 Purpose:
 - Analyze real uploaded video
 - Detect visual movement/activity
 - Detect motion peaks
 - Detect scene/cut changes
 - Measure momentum
 - Measure acceleration
 - Measure stability
 - Measure activity density
 - Score 30-second windows
 - Return Top 10 moments + Best moment

 IMPORTANT:
 - Does NOT create MP4
 - Does NOT modify /cut
 - Does NOT modify Voice Engine
 - Uses bounded-memory frame streaming
 - Optimized for long videos
 - Uses prefix sums for fast window scoring
=========================================================
*/

const fs = require("fs");
const { spawn } = require("child_process");

/* =====================================================
   CONFIG
===================================================== */

const CONFIG = {
  analysisWidth: 320,
  analysisHeight: 180,

  fps: 4,

  clipDuration: 30,
  windowStep: 1,

  sampleStep: 16,

  smoothingRadius: 2,

  sceneThreshold: 0.55,
  strongSceneThreshold: 0.75,

  motionPeakThreshold: 0.70,

  topLimit: 10,
  separationSeconds: 5,

  maxAnalysisFrames: 1000000,

  /*
  Safety:
  Maximum allowed FFmpeg analysis time.

  For very long videos we allow generous time,
  but we never let a broken FFmpeg process hang forever.
  */
  timeoutBaseMs: 10 * 60 * 1000,

  timeoutPerVideoMinuteMs: 20 * 1000
};

/* =====================================================
   HELPERS
===================================================== */

function safeNumber(value, fallback = 0) {
  const n = Number(value);

  return Number.isFinite(n)
    ? n
    : fallback;
}

function clamp(value, min = 0, max = 1) {
  return Math.max(
    min,
    Math.min(max, value)
  );
}

function round(value, digits = 4) {
  const p = Math.pow(10, digits);

  return (
    Math.round(value * p) /
    p
  );
}

function average(values) {
  if (
    !values ||
    values.length === 0
  ) {
    return 0;
  }

  let total = 0;

  for (
    let i = 0;
    i < values.length;
    i++
  ) {
    total += values[i];
  }

  return total / values.length;
}

function variance(values) {
  if (
    !values ||
    values.length < 2
  ) {
    return 0;
  }

  const avg =
    average(values);

  let total = 0;

  for (
    let i = 0;
    i < values.length;
    i++
  ) {
    const d =
      values[i] - avg;

    total += d * d;
  }

  return (
    total /
    values.length
  );
}

function standardDeviation(values) {
  return Math.sqrt(
    variance(values)
  );
}

function percentile(values, p) {
  if (
    !values ||
    values.length === 0
  ) {
    return 0;
  }

  const sorted =
    values
      .slice()
      .sort(
        (a, b) => a - b
      );

  const index =
    (sorted.length - 1) * p;

  const lower =
    Math.floor(index);

  const upper =
    Math.ceil(index);

  if (
    lower === upper
  ) {
    return sorted[lower];
  }

  const weight =
    index - lower;

  return (
    sorted[lower] *
      (1 - weight) +
    sorted[upper] *
      weight
  );
}

function median(values) {
  return percentile(
    values,
    0.5
  );
}

/* =====================================================
   COMMAND RUNNER
===================================================== */

function runCommand(
  command,
  args,
  options = {}
) {
  return new Promise(
    (resolve, reject) => {
      const child =
        spawn(
          command,
          args,
          {
            windowsHide: true,
            ...options
          }
        );

      let stdout = "";
      let stderr = "";

      child.stdout.on(
        "data",
        chunk => {
          stdout +=
            chunk.toString();
        }
      );

      child.stderr.on(
        "data",
        chunk => {
          stderr +=
            chunk.toString();
        }
      );

      child.on(
        "error",
        reject
      );

      child.on(
        "close",
        code => {
          if (
            code === 0
          ) {
            resolve({
              stdout,
              stderr
            });

            return;
          }

          reject(
            new Error(
              `${command} exited with code ${code}\n${stderr}`
            )
          );
        }
      );
    }
  );
}

/* =====================================================
   VIDEO INFO
===================================================== */

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

        "-show_entries",
        "stream=width,height,r_frame_rate,codec_name",

        "-of",
        "json",

        videoPath
      ]
    );

  let data = {};

  try {
    data =
      JSON.parse(
        result.stdout
      );
  } catch {
    data = {};
  }

  const duration =
    safeNumber(
      data?.format?.duration,
      0
    );

  const videoStream =
    Array.isArray(
      data.streams
    )
      ? data.streams.find(
          stream =>
            stream.width &&
            stream.height
        )
      : null;

  return {
    duration,

    width:
      safeNumber(
        videoStream?.width,
        0
      ),

    height:
      safeNumber(
        videoStream?.height,
        0
      ),

    codec:
      videoStream?.codec_name ||
      null
  };
}

/* =====================================================
   FRAME MOTION
===================================================== */

function calculateFrameMotion(
  previousFrame,
  currentFrame
) {
  if (
    !previousFrame ||
    !currentFrame
  ) {
    return 0;
  }

  const length =
    Math.min(
      previousFrame.length,
      currentFrame.length
    );

  let totalDifference = 0;
  let samples = 0;

  const step =
    Math.max(
      1,
      CONFIG.sampleStep
    );

  for (
    let i = 0;
    i < length;
    i += step
  ) {
    const a =
      previousFrame[i];

    const b =
      currentFrame[i];

    totalDifference +=
      Math.abs(
        a - b
      ) / 255;

    samples++;
  }

  if (
    samples === 0
  ) {
    return 0;
  }

  return (
    totalDifference /
    samples
  );
}

/* =====================================================
   SMOOTH
===================================================== */

function smoothValues(
  values,
  radius = 2
) {
  if (
    !values.length
  ) {
    return [];
  }

  const result =
    new Array(
      values.length
    );

  /*
  Prefix sum makes smoothing O(n)
  instead of nested loops.
  */

  const prefix =
    new Float64Array(
      values.length + 1
    );

  for (
    let i = 0;
    i < values.length;
    i++
  ) {
    prefix[i + 1] =
      prefix[i] +
      values[i];
  }

  for (
    let i = 0;
    i < values.length;
    i++
  ) {
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

    const total =
      prefix[end + 1] -
      prefix[start];

    result[i] =
      total /
      (end - start + 1);
  }

  return result;
}

/* =====================================================
   NORMALIZE MOTION
===================================================== */

function normalizeMotion(
  values
) {
  if (
    !values.length
  ) {
    return [];
  }

  const p50 =
    percentile(
      values,
      0.50
    );

  const p90 =
    percentile(
      values,
      0.90
    );

  const p98 =
    percentile(
      values,
      0.98
    );

  const scale =
    Math.max(
      p90 - p50,
      0.000001
    );

  return values.map(
    value => {
      let normalized =
        (value - p50) /
        scale;

      normalized =
        clamp(
          normalized,
          0,
          1
        );

      if (
        value >= p98
      ) {
        normalized =
          Math.min(
            1,
            normalized * 1.12
          );
      }

      return normalized;
    }
  );
}

/* =====================================================
   STREAM VIDEO FRAMES
===================================================== */

async function streamMotionFrames(
  videoPath,
  duration,
  progressCallback
) {
  return new Promise(
    (resolve, reject) => {
      const frameSize =
        CONFIG.analysisWidth *
        CONFIG.analysisHeight;

      const ffmpegArgs = [
        "-hide_banner",
        "-loglevel",
        "error",

        /*
        Important for server environments.
        Prevent FFmpeg from waiting for stdin.
        */

        "-nostdin",

        "-i",
        videoPath,

        "-an",

        "-vf",
        `fps=${CONFIG.fps},scale=${CONFIG.analysisWidth}:${CONFIG.analysisHeight}:flags=fast_bilinear,format=gray`,

        "-f",
        "rawvideo",

        "-pix_fmt",
        "gray",

        "pipe:1"
      ];

      const child =
        spawn(
          "ffmpeg",
          ffmpegArgs,
          {
            windowsHide: true,

            stdio: [
              "ignore",
              "pipe",
              "pipe"
            ]
          }
        );

      let buffer =
        Buffer.alloc(0);

      let previousFrame =
        null;

      const rawMotion =
        [];

      let frameIndex = 0;

      let lastProgress = 0;

      let finished = false;

      let stderr = "";

      /*
      Safety timeout.
      */

      const timeoutMs =
        Math.max(
          CONFIG.timeoutBaseMs,

          CONFIG.timeoutPerVideoMinuteMs *
            Math.max(
              1,
              duration / 60
            )
        );

      const timeout =
        setTimeout(
          () => {
            if (finished) {
              return;
            }

            finished = true;

            try {
              child.kill(
                "SIGKILL"
              );
            } catch {}

            reject(
              new Error(
                `Movement FFmpeg analysis timed out after ${Math.round(
                  timeoutMs / 60000
                )} minutes.`
              )
            );
          },
          timeoutMs
        );

      function fail(error) {
        if (finished) {
          return;
        }

        finished = true;

        clearTimeout(
          timeout
        );

        reject(error);
      }

      child.stdout.on(
        "data",
        chunk => {
          if (finished) {
            return;
          }

          buffer =
            Buffer.concat([
              buffer,
              chunk
            ]);

          while (
            buffer.length >=
            frameSize
          ) {
            if (finished) {
              return;
            }

            const frame =
              buffer.subarray(
                0,
                frameSize
              );

            buffer =
              buffer.subarray(
                frameSize
              );

            /*
            Copy current frame so the
            underlying pipe buffer can move.
            */

            const currentFrame =
              Buffer.from(
                frame
              );

            if (
              previousFrame
            ) {
              const motion =
                calculateFrameMotion(
                  previousFrame,
                  currentFrame
                );

              rawMotion.push(
                motion
              );
            }

            previousFrame =
              currentFrame;

            frameIndex++;

            if (
              frameIndex >
              CONFIG.maxAnalysisFrames
            ) {
              fail(
                new Error(
                  "Movement analysis frame limit exceeded."
                )
              );

              try {
                child.kill(
                  "SIGKILL"
                );
              } catch {}

              return;
            }

            /*
            Progress is based on actual
            video time represented by frames.
            */

            if (
              duration > 0 &&
              frameIndex % 8 === 0
            ) {
              const currentTime =
                frameIndex /
                CONFIG.fps;

              const progress =
                Math.min(
                  95,
                  Math.round(
                    (
                      currentTime /
                      duration
                    ) *
                      95
                  )
                );

              if (
                progress >
                lastProgress
              ) {
                lastProgress =
                  progress;

                if (
                  typeof progressCallback ===
                  "function"
                ) {
                  progressCallback(
                    progress
                  );
                }
              }
            }
          }
        }
      );

      child.stderr.on(
        "data",
        chunk => {
          stderr +=
            chunk.toString();

          /*
          Keep stderr bounded.
          FFmpeg should normally produce
          almost nothing with -loglevel error.
          */

          if (
            stderr.length >
            50000
          ) {
            stderr =
              stderr.slice(
                -50000
              );
          }
        }
      );

      child.on(
        "error",
        error => {
          fail(error);
        }
      );

      child.on(
        "close",
        code => {
          if (finished) {
            return;
          }

          finished = true;

          clearTimeout(
            timeout
          );

          if (
            code !== 0
          ) {
            reject(
              new Error(
                `FFmpeg movement analysis failed with code ${code}: ${stderr}`
              )
            );

            return;
          }

          resolve({
            rawMotion,
            frames:
              frameIndex
          });
        }
      );
    }
  );
}

/* =====================================================
   BUILD TIMELINE
===================================================== */

function buildMotionTimeline(
  rawMotion,
  duration
) {
  if (
    !rawMotion.length
  ) {
    return {
      values: [],
      normalized: [],
      times: [],
      duration
    };
  }

  const smoothed =
    smoothValues(
      rawMotion,
      CONFIG.smoothingRadius
    );

  const normalized =
    normalizeMotion(
      smoothed
    );

  const times =
    new Array(
      normalized.length
    );

  for (
    let i = 0;
    i < normalized.length;
    i++
  ) {
    times[i] =
      (i + 1) /
      CONFIG.fps;
  }

  return {
    values:
      smoothed,

    normalized,

    times,

    duration
  };
}

/* =====================================================
   MOTION PEAKS
===================================================== */

function findMotionPeaks(
  normalized,
  times
) {
  const peaks = [];

  if (
    normalized.length < 3
  ) {
    return peaks;
  }

  for (
    let i = 1;
    i <
    normalized.length - 1;
    i++
  ) {
    const current =
      normalized[i];

    const previous =
      normalized[i - 1];

    const next =
      normalized[i + 1];

    if (
      current >=
        CONFIG.motionPeakThreshold &&
      current >= previous &&
      current >= next
    ) {
      peaks.push({
        time:
          round(
            times[i],
            3
          ),

        motion:
          round(
            current,
            4
          )
      });
    }
  }

  peaks.sort(
    (a, b) =>
      b.motion -
      a.motion
  );

  return peaks.slice(
    0,
    50
  );
}

/* =====================================================
   SCENE CHANGES
===================================================== */

function detectSceneChanges(
  normalized,
  times
) {
  const changes = [];

  for (
    let i = 1;
    i < normalized.length;
    i++
  ) {
    const jump =
      Math.abs(
        normalized[i] -
          normalized[i - 1]
      );

    if (
      jump >=
      CONFIG.sceneThreshold
    ) {
      changes.push({
        time:
          round(
            times[i],
            3
          ),

        strength:
          round(
            clamp(
              jump,
              0,
              1
            ),
            4
          )
      });
    }
  }

  return changes;
}

/* =====================================================
   PREFIX SUM HELPERS
===================================================== */

function buildPrefixSum(
  values
) {
  const prefix =
    new Float64Array(
      values.length + 1
    );

  for (
    let i = 0;
    i < values.length;
    i++
  ) {
    prefix[i + 1] =
      prefix[i] +
      values[i];
  }

  return prefix;
}

function lowerBound(
  values,
  target
) {
  let low = 0;
  let high =
    values.length;

  while (
    low < high
  ) {
    const mid =
      (low + high) >>
      1;

    if (
      values[mid] <
      target
    ) {
      low =
        mid + 1;
    } else {
      high =
        mid;
    }
  }

  return low;
}

function upperBound(
  values,
  target
) {
  let low = 0;
  let high =
    values.length;

  while (
    low < high
  ) {
    const mid =
      (low + high) >>
      1;

    if (
      values[mid] <=
      target
    ) {
      low =
        mid + 1;
    } else {
      high =
        mid;
    }
  }

  return low;
}

/* =====================================================
   WINDOW RANGE
===================================================== */

function getTimelineRange(
  timeline,
  start,
  end
) {
  const times =
    timeline.times;

  if (
    !times.length
  ) {
    return {
      from: 0,
      to: 0
    };
  }

  const from =
    lowerBound(
      times,
      start
    );

  const to =
    lowerBound(
      times,
      end
    );

  return {
    from,
    to
  };
}

/* =====================================================
   WINDOW FEATURES
===================================================== */

function calculateWindowFeatures(
  values,
  sceneChanges,
  duration
) {
  if (
    !values.length
  ) {
    return {
      averageMotion: 0,
      peakMotion: 0,
      minimumMotion: 0,
      stability: 0,
      momentum: 0,
      acceleration: 0,
      density: 0,
      activeTime: 0,
      activePercent: 0,
      motionVariance: 0,
      motionMedian: 0,
      sceneCount:
        sceneChanges.length
    };
  }

  const averageMotion =
    average(values);

  const peakMotion =
    Math.max(
      ...values
    );

  const minimumMotion =
    Math.min(
      ...values
    );

  const motionVariance =
    variance(values);

  const motionMedian =
    median(values);

  const deviation =
    Math.sqrt(
      motionVariance
    );

  const stability =
    clamp(
      1 -
        deviation /
          Math.max(
            averageMotion,
            0.05
          ),
      0,
      1
    );

  /*
  Momentum
  */

  let momentumTotal = 0;
  let momentumCount = 0;

  for (
    let i = 1;
    i < values.length;
    i++
  ) {
    const persistence =
      1 -
      Math.abs(
        values[i] -
          values[i - 1]
      );

    momentumTotal +=
      clamp(
        persistence,
        0,
        1
      );

    momentumCount++;
  }

  const momentum =
    momentumCount > 0
      ? momentumTotal /
        momentumCount
      : 0;

  /*
  Acceleration
  */

  let accelerationTotal = 0;
  let accelerationCount = 0;

  for (
    let i = 2;
    i < values.length;
    i++
  ) {
    const firstChange =
      values[i - 1] -
      values[i - 2];

    const secondChange =
      values[i] -
      values[i - 1];

    const acceleration =
      Math.abs(
        secondChange -
          firstChange
      );

    accelerationTotal +=
      acceleration;

    accelerationCount++;
  }

  const acceleration =
    accelerationCount > 0
      ? clamp(
          (
            accelerationTotal /
            accelerationCount
          ) * 3,
          0,
          1
        )
      : 0;

  /*
  Activity density
  */

  let activeFrames = 0;

  for (
    let i = 0;
    i < values.length;
    i++
  ) {
    if (
      values[i] >= 0.35
    ) {
      activeFrames++;
    }
  }

  const density =
    values.length > 0
      ? activeFrames /
        values.length
      : 0;

  const activePercent =
    density * 100;

  const activeTime =
    duration * density;

  return {
    averageMotion,

    peakMotion,

    minimumMotion,

    stability,

    momentum,

    acceleration,

    density,

    activeTime,

    activePercent,

    motionVariance,

    motionMedian,

    sceneCount:
      sceneChanges.length
  };
}

/* =====================================================
   EDGE STRENGTH
===================================================== */

function calculateEdgeStrength(
  values
) {
  if (
    !values.length
  ) {
    return {
      start: 0,
      end: 0
    };
  }

  const edgeCount =
    Math.max(
      1,
      Math.floor(
        values.length *
          0.12
      )
    );

  const startValues =
    values.slice(
      0,
      edgeCount
    );

  const endValues =
    values.slice(
      values.length -
        edgeCount
    );

  return {
    start:
      average(
        startValues
      ),

    end:
      average(
        endValues
      )
  };
}

/* =====================================================
   SCORE WINDOW
===================================================== */

function scoreMovementWindow(
  values,
  sceneChanges,
  start,
  end
) {
  const duration =
    Math.max(
      0.001,
      end - start
    );

  const features =
    calculateWindowFeatures(
      values,
      sceneChanges,
      duration
    );

  const edge =
    calculateEdgeStrength(
      values
    );

  /*
  =======================================================
  MAX MOVEMENT SCORE — 100 POINTS
  =======================================================

  Average movement       25
  Peak movement          20
  Momentum               15
  Activity density       10
  Acceleration           10
  Scene events            7
  Stability               5
  Start strength          4
  End strength            4

  TOTAL                  100
  =======================================================
  */

  const averageScore =
    features.averageMotion *
    25;

  const peakScore =
    features.peakMotion *
    20;

  const momentumScore =
    features.momentum *
    15;

  const densityScore =
    features.density *
    10;

  const accelerationScore =
    features.acceleration *
    10;

  const sceneScore =
    Math.min(
      1,
      features.sceneCount / 3
    ) * 7;

  const stabilityScore =
    features.stability *
    5;

  const startScore =
    edge.start *
    4;

  const endScore =
    edge.end *
    4;

  let score =
    averageScore +
    peakScore +
    momentumScore +
    densityScore +
    accelerationScore +
    sceneScore +
    stabilityScore +
    startScore +
    endScore;

  /*
  Penalize very inactive windows.
  */

  if (
    features.averageMotion <
    0.10
  ) {
    score *= 0.35;
  }

  if (
    features.density <
    0.15
  ) {
    score *= 0.50;
  }

  /*
  Balanced activity bonus.
  */

  if (
    features.density >=
      0.35 &&
    features.density <=
      0.95
  ) {
    score += 2;
  }

  score =
    Math.min(
      100,
      score
    );

  return {
    start:
      round(
        start,
        3
      ),

    end:
      round(
        end,
        3
      ),

    duration:
      round(
        duration,
        3
      ),

    activeTime:
      round(
        features.activeTime,
        3
      ),

    activePercent:
      round(
        features.activePercent,
        2
      ),

    averageMotion:
      round(
        features.averageMotion,
        4
      ),

    peakMotion:
      round(
        features.peakMotion,
        4
      ),

    minimumMotion:
      round(
        features.minimumMotion,
        4
      ),

    motionMedian:
      round(
        features.motionMedian,
        4
      ),

    motionVariance:
      round(
        features.motionVariance,
        5
      ),

    stability:
      round(
        features.stability,
        4
      ),

    momentum:
      round(
        features.momentum,
        4
      ),

    acceleration:
      round(
        features.acceleration,
        4
      ),

    activityDensity:
      round(
        features.density,
        4
      ),

    sceneChanges:
      features.sceneCount,

    startStrength:
      round(
        edge.start,
        4
      ),

    endStrength:
      round(
        edge.end,
        4
      ),

    score:
      round(
        score,
        2
      )
  };
}

/* =====================================================
   CREATE MOVEMENT CANDIDATES
===================================================== */

function createMovementCandidates(
  timeline,
  sceneChanges,
  duration
) {
  const candidates = [];

  const clip =
    CONFIG.clipDuration;

  if (
    duration <= clip
  ) {
    const range =
      getTimelineRange(
        timeline,
        0,
        duration
      );

    const values =
      timeline.normalized.slice(
        range.from,
        range.to
      );

    const scenes =
      sceneChanges.filter(
        change =>
          change.time >= 0 &&
          change.time <
            duration
      );

    candidates.push(
      scoreMovementWindow(
        values,
        scenes,
        0,
        duration
      )
    );

    return candidates;
  }

  const maxStart =
    Math.max(
      0,
      duration - clip
    );

  /*
  Instead of scanning the entire
  timeline for every window, use
  binary-search ranges.
  */

  for (
    let start = 0;
    start <= maxStart;
    start +=
      CONFIG.windowStep
  ) {
    const end =
      Math.min(
        duration,
        start + clip
      );

    const range =
      getTimelineRange(
        timeline,
        start,
        end
      );

    if (
      range.to <=
      range.from
    ) {
      continue;
    }

    const values =
      timeline.normalized.slice(
        range.from,
        range.to
      );

    const scenes =
      sceneChanges.filter(
        change =>
          change.time >= start &&
          change.time < end
      );

    candidates.push(
      scoreMovementWindow(
        values,
        scenes,
        start,
        end
      )
    );
  }

  /*
  Guarantee final possible window.
  */

  const finalStart =
    maxStart;

  if (
    !candidates.some(
      item =>
        Math.abs(
          item.start -
            finalStart
        ) <
        0.001
    )
  ) {
    const end =
      Math.min(
        duration,
        finalStart +
          clip
      );

    const range =
      getTimelineRange(
        timeline,
        finalStart,
        end
      );

    if (
      range.to >
      range.from
    ) {
      const values =
        timeline.normalized.slice(
          range.from,
          range.to
        );

      const scenes =
        sceneChanges.filter(
          change =>
            change.time >=
              finalStart &&
            change.time <
              end
        );

      candidates.push(
        scoreMovementWindow(
          values,
          scenes,
          finalStart,
          end
        )
      );
    }
  }

  return candidates;
}

/* =====================================================
   TOP SEPARATED
===================================================== */

function getTopSeparated(
  candidates
) {
  const sorted =
    candidates
      .slice()
      .sort(
        (a, b) =>
          b.score -
          a.score
      );

  const selected = [];

  for (
    let i = 0;
    i < sorted.length;
    i++
  ) {
    const candidate =
      sorted[i];

    const tooClose =
      selected.some(
        existing =>
          Math.abs(
            existing.start -
              candidate.start
          ) <
          CONFIG.separationSeconds
      );

    if (
      !tooClose
    ) {
      selected.push(
        candidate
      );
    }

    if (
      selected.length >=
      CONFIG.topLimit
    ) {
      break;
    }
  }

  return selected;
}

/* =====================================================
   ANALYZE MOVEMENT
===================================================== */

async function analyzeMovement(
  videoPath,
  duration,
  progressCallback
) {
  if (
    !videoPath ||
    !fs.existsSync(
      videoPath
    )
  ) {
    throw new Error(
      "Video file not found."
    );
  }

  let actualDuration =
    safeNumber(
      duration,
      0
    );

  /*
  If duration is not supplied,
  get it from FFprobe.
  */

  let videoInfo =
    null;

  if (
    actualDuration <= 0
  ) {
    videoInfo =
      await getVideoInfo(
        videoPath
      );

    actualDuration =
      videoInfo.duration;
  }

  if (
    actualDuration <= 0
  ) {
    throw new Error(
      "Unable to determine video duration."
    );
  }

  if (
    typeof progressCallback ===
    "function"
  ) {
    progressCallback(2);
  }

  /*
  Get metadata when possible.
  */

  if (
    !videoInfo
  ) {
    try {
      videoInfo =
        await getVideoInfo(
          videoPath
        );
    } catch {
      videoInfo =
        null;
    }
  }

  if (
    typeof progressCallback ===
    "function"
  ) {
    progressCallback(3);
  }

  /*
  =======================================================
  REAL VIDEO FRAME ANALYSIS
  =======================================================
  */

  const streamResult =
    await streamMotionFrames(
      videoPath,
      actualDuration,
      progressCallback
    );

  if (
    !streamResult.rawMotion.length
  ) {
    throw new Error(
      "No usable video frames were extracted for movement analysis."
    );
  }

  if (
    typeof progressCallback ===
    "function"
  ) {
    progressCallback(96);
  }

  /*
  =======================================================
  BUILD TIMELINE
  =======================================================
  */

  const timeline =
    buildMotionTimeline(
      streamResult.rawMotion,
      actualDuration
    );

  /*
  =======================================================
  MOTION PEAKS
  =======================================================
  */

  const motionPeaks =
    findMotionPeaks(
      timeline.normalized,
      timeline.times
    );

  if (
    typeof progressCallback ===
    "function"
  ) {
    progressCallback(97);
  }

  /*
  =======================================================
  SCENE CHANGES
  =======================================================
  */

  const sceneChanges =
    detectSceneChanges(
      timeline.normalized,
      timeline.times
    );

  /*
  =======================================================
  CANDIDATES
  =======================================================
  */

  const candidates =
    createMovementCandidates(
      timeline,
      sceneChanges,
      actualDuration
    );

  if (
    typeof progressCallback ===
    "function"
  ) {
    progressCallback(98);
  }

  /*
  =======================================================
  TOP MOMENTS
  =======================================================
  */

  const top =
    getTopSeparated(
      candidates
    );

  const best =
    top.length > 0
      ? top[0]
      : null;

  /*
  =======================================================
  GLOBAL STATISTICS
  =======================================================
  */

  const normalized =
    timeline.normalized;

  const globalAverage =
    average(
      normalized
    );

  const globalPeak =
    normalized.length
      ? Math.max(
          ...normalized
        )
      : 0;

  const globalMinimum =
    normalized.length
      ? Math.min(
          ...normalized
        )
      : 0;

  const globalVariance =
    variance(
      normalized
    );

  const globalMedian =
    median(
      normalized
    );

  const globalStd =
    standardDeviation(
      normalized
    );

  const globalStability =
    clamp(
      1 -
        globalStd /
          Math.max(
            globalAverage,
            0.05
          ),
      0,
      1
    );

  if (
    typeof progressCallback ===
    "function"
  ) {
    progressCallback(100);
  }

  /*
  =======================================================
  FINAL RESULT
  =======================================================
  */

  return {
    engine:
      "Movement Engine MAX V3",

    detector:
      "FFmpeg streaming frame-difference motion analysis",

    analysisMode:
      "bounded-memory streaming",

    duration:
      round(
        actualDuration,
        3
      ),

    videoInfo:
      videoInfo
        ? {
            width:
              videoInfo.width,

            height:
              videoInfo.height,

            codec:
              videoInfo.codec
          }
        : null,

    framesAnalyzed:
      streamResult.frames,

    analysisFPS:
      CONFIG.fps,

    globalMotion: {
      average:
        round(
          globalAverage,
          4
        ),

      peak:
        round(
          globalPeak,
          4
        ),

      minimum:
        round(
          globalMinimum,
          4
        ),

      median:
        round(
          globalMedian,
          4
        ),

      variance:
        round(
          globalVariance,
          5
        ),

      stability:
        round(
          globalStability,
          4
        )
    },

    motionPeaks,

    motionPeakCount:
      motionPeaks.length,

    sceneChanges,

    sceneChangeCount:
      sceneChanges.length,

    candidatesAnalyzed:
      candidates.length,

    top,

    best,

    settings: {
      analysisWidth:
        CONFIG.analysisWidth,

      analysisHeight:
        CONFIG.analysisHeight,

      fps:
        CONFIG.fps,

      sampleStep:
        CONFIG.sampleStep,

      clipDuration:
        CONFIG.clipDuration,

      windowStep:
        CONFIG.windowStep,

      sceneThreshold:
        CONFIG.sceneThreshold,

      strongSceneThreshold:
        CONFIG.strongSceneThreshold,

      motionPeakThreshold:
        CONFIG.motionPeakThreshold,

      topLimit:
        CONFIG.topLimit,

      separationSeconds:
        CONFIG.separationSeconds,

      memoryMode:
        "streaming — previous/current frame only",

      optimization:
        "prefix/binary-search window indexing"
    }
  };
}

/* =====================================================
   EXPORTS
===================================================== */

module.exports = {
  analyzeMovement,

  getVideoInfo,

  calculateFrameMotion,

  smoothValues,

  normalizeMotion,

  findMotionPeaks,

  detectSceneChanges,

  scoreMovementWindow,

  createMovementCandidates,

  getTopSeparated
};
