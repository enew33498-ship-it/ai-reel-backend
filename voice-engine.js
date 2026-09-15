/*
========================================================
 AI REEL EDITOR
 VOICE ENGINE MAX V5
========================================================

GOAL
----
Maximum practical speech/voice detection for the
AI Reel Editor.

ENGINE PIPELINE
---------------

VIDEO
  ↓
FFmpeg
  ↓
16 kHz MONO WAV
  ↓
SILERO VAD
  ↓
MULTI-THRESHOLD ANALYSIS
  ├── Sensitive
  ├── Balanced
  └── Strict
  ↓
SPEECH CONSENSUS
  ↓
SEGMENT MERGING
  ↓
VOICE FEATURES
  ├── Speech coverage
  ├── Average VAD
  ├── Peak VAD
  ├── Continuity
  ├── Density
  ├── Start strength
  ├── End strength
  ├── Stability
  └── Confidence
  ↓
30 SECOND SLIDING WINDOWS
  ↓
TOP CANDIDATES
  ↓
BEST VOICE MOMENT

IMPORTANT
---------
Existing server.js can continue using:

const { analyzeVoice } = require("./voice-engine");

No server.js changes are required for this engine.

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

const {
  File: DecibriFile
} = require("decibri");


/* ======================================================
   GLOBAL CONFIG
====================================================== */

const SAMPLE_RATE = 16000;

const CLIP_DURATION = 30;

const WINDOW_STEP = 1;

const MIN_SPEECH_DURATION = 0.12;

const SEGMENT_GAP = 0.30;


/*
--------------------------------------------------------
MULTI THRESHOLD

Sensitive:
detects quieter speech

Balanced:
normal speech detection

Strict:
strong speech detection
--------------------------------------------------------
*/

const VAD_PROFILES = [
  {
    name: "sensitive",
    threshold: 0.35,
    holdoffMs: 250
  },

  {
    name: "balanced",
    threshold: 0.50,
    holdoffMs: 300
  },

  {
    name: "strict",
    threshold: 0.65,
    holdoffMs: 350
  }
];


/*
--------------------------------------------------------
TOP RESULTS
--------------------------------------------------------
*/

const TOP_LIMIT = 10;

const SEPARATION_SECONDS = 5;


/*
--------------------------------------------------------
TEMP FILE PREFIX
--------------------------------------------------------
*/

const TEMP_PREFIX =
  "ai-reel-voice-max-v5";


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
   ROUND
====================================================== */

function round(
  value,
  digits = 3
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
   CHECK FFMPEG
====================================================== */

async function checkFFmpeg() {

  try {

    await runCommand(
      "ffmpeg",
      [
        "-version"
      ]
    );

    return true;

  } catch (
    error
  ) {

    throw new Error(
      "FFmpeg is not available on the server."
    );

  }

}


/* ======================================================
   EXTRACT AUDIO
====================================================== */

async function extractVoiceAudio(
  videoPath
) {

  const tempName =
    `${TEMP_PREFIX}-${crypto.randomUUID()}.wav`;


  const wavPath =
    path.join(
      os.tmpdir(),
      tempName
    );


  console.log("");
  console.log(
    "================================================"
  );

  console.log(
    "🎤 VOICE ENGINE MAX V5"
  );

  console.log(
    "AUDIO EXTRACTION"
  );

  console.log(
    "INPUT:",
    videoPath
  );

  console.log(
    "OUTPUT:",
    wavPath
  );

  console.log(
    "================================================"
  );


  await checkFFmpeg();


  const args = [

    "-y",

    "-hide_banner",

    "-loglevel",
    "error",

    "-i",
    videoPath,

    "-vn",

    "-ac",
    "1",

    "-ar",
    String(
      SAMPLE_RATE
    ),

    "-c:a",
    "pcm_s16le",

    wavPath

  ];


  await runCommand(
    "ffmpeg",
    args
  );


  if (
    !fs.existsSync(
      wavPath
    )
  ) {

    throw new Error(
      "Voice MAX audio extraction failed."
    );

  }


  const stats =
    fs.statSync(
      wavPath
    );


  if (
    stats.size < 1000
  ) {

    throw new Error(
      "Extracted audio is empty or too small."
    );

  }


  console.log(
    "[VOICE MAX] WAV SIZE:",
    (stats.size / 1024 / 1024)
      .toFixed(2),
    "MB"
  );


  return wavPath;

}


/* ======================================================
   CLEAN TEMP FILE
====================================================== */

function cleanupTempAudio(
  wavPath
) {

  if (
    !wavPath
  ) {

    return;

  }


  try {

    if (
      fs.existsSync(
        wavPath
      )
    ) {

      fs.unlinkSync(
        wavPath
      );

      console.log(
        "[VOICE MAX] TEMP WAV DELETED"
      );

    }

  } catch (
    error
  ) {

    console.log(
      "[VOICE MAX] CLEANUP ERROR:",
      error.message
    );

  }

}


/* ======================================================
   RUN ONE SILERO PROFILE
====================================================== */

async function runSileroProfile(
  wavPath,
  profile
) {

  console.log("");
  console.log(
    "----------------------------------------------"
  );

  console.log(
    "[VOICE MAX] SILERO PROFILE:",
    profile.name
  );

  console.log(
    "[THRESHOLD]:",
    profile.threshold
  );

  console.log(
    "[HOLDOFF]:",
    profile.holdoffMs
  );

  console.log(
    "----------------------------------------------"
  );


  const file =
    await DecibriFile.open(
      wavPath,
      {
        sampleRate:
          SAMPLE_RATE,

        vad: {
          model:
            "silero",

          threshold:
            profile.threshold,

          holdoffMs:
            profile.holdoffMs
        }
      }
    );


  try {

    const report =
      await file.analyze();


    if (
      !report ||
      !Array.isArray(
        report.scores
      ) ||
      !Array.isArray(
        report.segments
      )
    ) {

      throw new Error(
        `Invalid Silero report for ${profile.name} profile.`
      );

    }


    console.log(
      `[VOICE MAX] ${profile.name} windows:`,
      report.scores.length
    );


    console.log(
      `[VOICE MAX] ${profile.name} segments:`,
      report.segments.length
    );


    return {

      profile:
        profile.name,

      threshold:
        profile.threshold,

      holdoffMs:
        profile.holdoffMs,

      scores:
        report.scores,

      segments:
        report.segments

    };

  } finally {

    try {

      file.close();

    } catch (_) {}

  }

}


/* ======================================================
   NORMALIZE SEGMENTS
====================================================== */

function normalizeSegments(
  segments,
  videoDuration
) {

  const normalized = [];


  for (
    const segment of
    segments || []
  ) {

    let start =
      safeNumber(
        segment.start
      );

    let end =
      safeNumber(
        segment.end
      );


    start =
      Math.max(
        0,
        start
      );


    end =
      Math.min(
        videoDuration,
        end
      );


    if (
      end <= start
    ) {

      continue;

    }


    const duration =
      end -
      start;


    if (
      duration <
      MIN_SPEECH_DURATION
    ) {

      continue;

    }


    normalized.push({

      start,

      end,

      duration

    });

  }


  normalized.sort(
    (a, b) =>
      a.start -
      b.start
  );


  return normalized;

}


/* ======================================================
   MERGE SEGMENTS
====================================================== */

function mergeSegments(
  segments,
  maxGap = SEGMENT_GAP
) {

  if (
    !segments ||
    segments.length === 0
  ) {

    return [];

  }


  const sorted =
    [...segments].sort(
      (a, b) =>
        a.start -
        b.start
    );


  const merged = [];


  for (
    const segment of sorted
  ) {

    if (
      merged.length === 0
    ) {

      merged.push({

        start:
          segment.start,

        end:
          segment.end

      });

      continue;

    }


    const previous =
      merged[
        merged.length - 1
      ];


    if (
      segment.start -
        previous.end
      <= maxGap
    ) {

      previous.end =
        Math.max(
          previous.end,
          segment.end
        );

    } else {

      merged.push({

        start:
          segment.start,

        end:
          segment.end

      });

    }

  }


  return merged.map(
    segment => ({

      start:
        round(
          segment.start
        ),

      end:
        round(
          segment.end
        ),

      duration:
        round(
          segment.end -
          segment.start
        )

    })
  );

}


/* ======================================================
   GET OVERLAP
====================================================== */

function getOverlap(
  aStart,
  aEnd,
  bStart,
  bEnd
) {

  const start =
    Math.max(
      aStart,
      bStart
    );


  const end =
    Math.min(
      aEnd,
      bEnd
    );


  if (
    end <= start
  ) {

    return 0;

  }


  return end -
    start;

}


/* ======================================================
   SPEECH TIME
====================================================== */

function calculateSpeechTime(
  segments,
  start,
  end
) {

  let total = 0;


  for (
    const segment of
    segments
  ) {

    if (
      segment.end <= start
    ) {

      continue;

    }


    if (
      segment.start >= end
    ) {

      break;

    }


    total +=
      getOverlap(
        start,
        end,
        segment.start,
        segment.end
      );

  }


  return clamp(
    total,
    0,
    end - start
  );

}


/* ======================================================
   WINDOW SEGMENTS
====================================================== */

function getWindowSegments(
  segments,
  start,
  end
) {

  const result = [];


  for (
    const segment of
    segments
  ) {

    if (
      segment.end <= start
    ) {

      continue;

    }


    if (
      segment.start >= end
    ) {

      break;

    }


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

      result.push({

        start:
          overlapStart,

        end:
          overlapEnd,

        duration:
          overlapEnd -
          overlapStart

      });

    }

  }


  return result;

}


/* ======================================================
   AVERAGE VAD
====================================================== */

function calculateAverageVad(
  scores,
  start,
  end
) {

  let weighted =
    0;

  let duration =
    0;


  for (
    const item of
    scores || []
  ) {

    const itemStart =
      safeNumber(
        item.start
      );


    const itemEnd =
      safeNumber(
        item.end
      );


    if (
      itemEnd <= start
    ) {

      continue;

    }


    if (
      itemStart >= end
    ) {

      break;

    }


    const overlap =
      getOverlap(
        start,
        end,
        itemStart,
        itemEnd
      );


    if (
      overlap <= 0
    ) {

      continue;

    }


    const vad =
      clamp(
        safeNumber(
          item.vadScore
        )
      );


    weighted +=
      vad *
      overlap;


    duration +=
      overlap;

  }


  if (
    duration <= 0
  ) {

    return 0;

  }


  return clamp(
    weighted /
      duration
  );

}


/* ======================================================
   PEAK VAD
====================================================== */

function calculatePeakVad(
  scores,
  start,
  end
) {

  let peak = 0;


  for (
    const item of
    scores || []
  ) {

    const itemStart =
      safeNumber(
        item.start
      );


    const itemEnd =
      safeNumber(
        item.end
      );


    if (
      itemEnd <= start
    ) {

      continue;

    }


    if (
      itemStart >= end
    ) {

      break;

    }


    const overlap =
      getOverlap(
        start,
        end,
        itemStart,
        itemEnd
      );


    if (
      overlap <= 0
    ) {

      continue;

    }


    peak =
      Math.max(
        peak,
        clamp(
          safeNumber(
            item.vadScore
          )
        )
      );

  }


  return peak;

}


/* ======================================================
   MIN VAD
====================================================== */

function calculateMinimumVad(
  scores,
  start,
  end
) {

  let minimum =
    1;

  let found = false;


  for (
    const item of
    scores || []
  ) {

    const itemStart =
      safeNumber(
        item.start
      );


    const itemEnd =
      safeNumber(
        item.end
      );


    if (
      itemEnd <= start
    ) {

      continue;

    }


    if (
      itemStart >= end
    ) {

      break;

    }


    const overlap =
      getOverlap(
        start,
        end,
        itemStart,
        itemEnd
      );


    if (
      overlap <= 0
    ) {

      continue;

    }


    minimum =
      Math.min(
        minimum,
        clamp(
          safeNumber(
            item.vadScore
          )
        )
      );


    found = true;

  }


  if (
    !found
  ) {

    return 0;

  }


  return minimum;

}


/* ======================================================
   VAD STABILITY
====================================================== */

function calculateVadStability(
  scores,
  start,
  end
) {

  let values = [];


  for (
    const item of
    scores || []
  ) {

    const itemStart =
      safeNumber(
        item.start
      );


    const itemEnd =
      safeNumber(
        item.end
      );


    if (
      itemEnd <= start
    ) {

      continue;

    }


    if (
      itemStart >= end
    ) {

      break;

    }


    const overlap =
      getOverlap(
        start,
        end,
        itemStart,
        itemEnd
      );


    if (
      overlap <= 0
    ) {

      continue;

    }


    values.push(
      clamp(
        safeNumber(
          item.vadScore
        )
      )
    );

  }


  if (
    values.length < 2
  ) {

    return values.length
      ? values[0]
      : 0;

  }


  const mean =
    values.reduce(
      (sum, value) =>
        sum + value,
      0
    ) /
    values.length;


  let variance = 0;


  for (
    const value of values
  ) {

    variance +=
      Math.pow(
        value - mean,
        2
      );

  }


  variance /=
    values.length;


  const standardDeviation =
    Math.sqrt(
      variance
    );


  return clamp(
    1 -
      standardDeviation
  );

}


/* ======================================================
   START STRENGTH
====================================================== */

function calculateStartStrength(
  scores,
  start,
  end
) {

  const rangeEnd =
    Math.min(
      end,
      start + 3
    );


  return calculateAverageVad(
    scores,
    start,
    rangeEnd
  );

}


/* ======================================================
   END STRENGTH
====================================================== */

function calculateEndStrength(
  scores,
  start,
  end
) {

  const rangeStart =
    Math.max(
      start,
      end - 3
    );


  return calculateAverageVad(
    scores,
    rangeStart,
    end
  );

}


/* ======================================================
   CONTINUITY
====================================================== */

function calculateContinuity(
  segments,
  start,
  end
) {

  const duration =
    end - start;


  if (
    duration <= 0
  ) {

    return 0;

  }


  if (
    segments.length === 0
  ) {

    return 0;

  }


  let covered = 0;


  for (
    const segment of
    segments
  ) {

    covered +=
      getOverlap(
        start,
        end,
        segment.start,
        segment.end
      );

  }


  const coverage =
    clamp(
      covered /
        duration
    );


  const gaps =
    Math.max(
      0,
      segments.length - 1
    );


  const gapPenalty =
    Math.min(
      0.30,
      gaps * 0.02
    );


  return clamp(
    coverage -
      gapPenalty
  );

}


/* ======================================================
   SPEECH DENSITY
====================================================== */

function calculateSpeechDensity(
  segments,
  start,
  end
) {

  const windowDuration =
    end - start;


  if (
    windowDuration <= 0
  ) {

    return 0;

  }


  let weighted = 0;


  for (
    const segment of
    segments
  ) {

    const overlap =
      getOverlap(
        start,
        end,
        segment.start,
        segment.end
      );


    if (
      overlap > 0
    ) {

      weighted +=
        overlap;

    }

  }


  return clamp(
    weighted /
      windowDuration
  );

}


/* ======================================================
   SPEECH EVENT COUNT
====================================================== */

function countSpeechEvents(
  segments,
  start,
  end
) {

  let count = 0;


  for (
    const segment of
    segments
  ) {

    if (
      segment.end <= start
    ) {

      continue;

    }


    if (
      segment.start >= end
    ) {

      break;

    }


    if (
      getOverlap(
        start,
        end,
        segment.start,
        segment.end
      ) > 0
    ) {

      count++;

    }

  }


  return count;

}


/* ======================================================
   CONSENSUS SCORE
====================================================== */

function calculateConsensus(
  sensitive,
  balanced,
  strict
) {

  /*
  Sensitive catches quiet speech.
  Balanced is the main signal.
  Strict confirms stronger speech.

  We don't require strict speech everywhere,
  otherwise quiet human speech could be lost.
  */


  const score =
    (
      sensitive * 0.25
      +
      balanced * 0.50
      +
      strict * 0.25
    );


  return clamp(
    score
  );

}


/* ======================================================
   BUILD CONSENSUS SEGMENTS
====================================================== */

function buildConsensusSegments(
  profileReports,
  videoDuration
) {

  const sensitive =
    profileReports
      .sensitive
      .segments;


  const balanced =
    profileReports
      .balanced
      .segments;


  const strict =
    profileReports
      .strict
      .segments;


  const normalizedSensitive =
    normalizeSegments(
      sensitive,
      videoDuration
    );


  const normalizedBalanced =
    normalizeSegments(
      balanced,
      videoDuration
    );


  const normalizedStrict =
    normalizeSegments(
      strict,
      videoDuration
    );


  /*
  Main speech source:
  balanced profile.
  */

  let base =
    normalizedBalanced;


  /*
  If balanced finds nothing but
  sensitive finds speech, use sensitive.
  */

  if (
    base.length === 0
    &&
    normalizedSensitive.length > 0
  ) {

    base =
      normalizedSensitive;

  }


  /*
  Build expanded intervals from
  sensitive detection around the
  balanced speech.

  This prevents tiny VAD gaps from
  destroying one continuous sentence.
  */

  const expanded = [];


  for (
    const segment of
    base
  ) {

    const nearby =
      normalizedSensitive
        .filter(
          candidate =>
            candidate.end >
              segment.start -
              0.35
            &&
            candidate.start <
              segment.end +
              0.35
        );


    let start =
      segment.start;


    let end =
      segment.end;


    for (
      const candidate of
      nearby
    ) {

      start =
        Math.min(
          start,
          candidate.start
        );


      end =
        Math.max(
          end,
          candidate.end
        );

    }


    expanded.push({

      start,

      end

    });

  }


  const merged =
    mergeSegments(
      expanded,
      0.45
    );


  /*
  Attach confidence metadata.
  */

  return merged.map(
    segment => {

      const segmentStart =
        segment.start;


      const segmentEnd =
        segment.end;


      const sensitiveTime =
        calculateSpeechTime(
          normalizedSensitive,
          segmentStart,
          segmentEnd
        );


      const balancedTime =
        calculateSpeechTime(
          normalizedBalanced,
          segmentStart,
          segmentEnd
        );


      const strictTime =
        calculateSpeechTime(
          normalizedStrict,
          segmentStart,
          segmentEnd
        );


      const duration =
        segmentEnd -
        segmentStart;


      const sensitiveCoverage =
        duration > 0
          ? sensitiveTime /
            duration
          : 0;


      const balancedCoverage =
        duration > 0
          ? balancedTime /
            duration
          : 0;


      const strictCoverage =
        duration > 0
          ? strictTime /
            duration
          : 0;


      const consensus =
        calculateConsensus(
          sensitiveCoverage,
          balancedCoverage,
          strictCoverage
        );


      return {

        start:
          round(
            segmentStart
          ),

        end:
          round(
            segmentEnd
          ),

        duration:
          round(
            duration
          ),

        sensitiveCoverage:
          round(
            sensitiveCoverage,
            4
          ),

        balancedCoverage:
          round(
            balancedCoverage,
            4
          ),

        strictCoverage:
          round(
            strictCoverage,
            4
          ),

        consensus:
          round(
            consensus,
            4
          )

      };

    }
  );

}


/* ======================================================
   CALCULATE VOICE SCORE
====================================================== */

function calculateVoiceScore(
  speechCoverage,
  averageVad,
  peakVad,
  continuity,
  density,
  stability,
  consensus,
  startStrength,
  endStrength,
  eventCount
) {

  /*
  ------------------------------------------------------
  MAX VOICE SCORE

  Speech coverage       35
  Average VAD           20
  Consensus              12
  Continuity              8
  Density                 6
  Peak                    5
  Stability               5
  Start strength          3
  End strength            3
  Event quality            3
  ------------------------------------------------------

  TOTAL = 100
  ------------------------------------------------------
  */


  const coverageScore =
    clamp(
      speechCoverage
    ) * 35;


  const averageScore =
    clamp(
      averageVad
    ) * 20;


  const consensusScore =
    clamp(
      consensus
    ) * 12;


  const continuityScore =
    clamp(
      continuity
    ) * 8;


  const densityScore =
    clamp(
      density
    ) * 6;


  const peakScore =
    clamp(
      peakVad
    ) * 5;


  const stabilityScore =
    clamp(
      stability
    ) * 5;


  const startScore =
    clamp(
      startStrength
    ) * 3;


  const endScore =
    clamp(
      endStrength
    ) * 3;


  /*
  Prefer a healthy number of
  speech events.

  Too few = possibly noise/long tone.
  Too many = possibly fragmented/noisy.
  */

  let eventQuality = 0;


  if (
    eventCount >= 1 &&
    eventCount <= 12
  ) {

    eventQuality = 1;

  } else if (
    eventCount > 12 &&
    eventCount <= 20
  ) {

    eventQuality = 0.75;

  } else if (
    eventCount > 20
  ) {

    eventQuality = 0.50;

  }


  const eventScore =
    eventQuality * 3;


  const rawScore =
    coverageScore
    +
    averageScore
    +
    consensusScore
    +
    continuityScore
    +
    densityScore
    +
    peakScore
    +
    stabilityScore
    +
    startScore
    +
    endScore
    +
    eventScore;


  return round(
    clamp(
      rawScore / 100
    ) * 100,
    2
  );

}


/* ======================================================
   SCORE CANDIDATE
====================================================== */

function scoreCandidate(
  start,
  end,
  speechSegments,
  balancedScores,
  sensitiveScores,
  strictScores
) {

  const duration =
    end -
    start;


  if (
    duration <= 0
  ) {

    return null;

  }


  const windowSegments =
    getWindowSegments(
      speechSegments,
      start,
      end
    );


  const activeTime =
    calculateSpeechTime(
      speechSegments,
      start,
      end
    );


  const speechCoverage =
    clamp(
      activeTime /
        duration
    );


  const averageVad =
    calculateAverageVad(
      balancedScores,
      start,
      end
    );


  const peakVad =
    calculatePeakVad(
      balancedScores,
      start,
      end
    );


  const minimumVad =
    calculateMinimumVad(
      balancedScores,
      start,
      end
    );


  const stability =
    calculateVadStability(
      balancedScores,
      start,
      end
    );


  const continuity =
    calculateContinuity(
      windowSegments,
      start,
      end
    );


  const density =
    calculateSpeechDensity(
      speechSegments,
      start,
      end
    );


  const startStrength =
    calculateStartStrength(
      balancedScores,
      start,
      end
    );


  const endStrength =
    calculateEndStrength(
      balancedScores,
      start,
      end
    );


  const sensitiveCoverage =
    clamp(
      calculateSpeechTime(
        speechSegments,
        start,
        end
      ) /
      duration
    );


  /*
  Strict and sensitive are recalculated
  using their own score arrays.
  */

  const sensitiveAverage =
    calculateAverageVad(
      sensitiveScores,
      start,
      end
    );


  const strictAverage =
    calculateAverageVad(
      strictScores,
      start,
      end
    );


  const consensus =
    calculateConsensus(
      sensitiveAverage,
      averageVad,
      strictAverage
    );


  const eventCount =
    countSpeechEvents(
      windowSegments,
      start,
      end
    );


  const score =
    calculateVoiceScore(
      speechCoverage,
      averageVad,
      peakVad,
      continuity,
      density,
      stability,
      consensus,
      startStrength,
      endStrength,
      eventCount
    );


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
        duration
      ),

    activeTime:
      round(
        activeTime
      ),

    activePercent:
      round(
        speechCoverage * 100,
        2
      ),

    averageVad:
      round(
        averageVad,
        4
      ),

    peakVad:
      round(
        peakVad,
        4
      ),

    minimumVad:
      round(
        minimumVad,
        4
      ),

    vadStability:
      round(
        stability,
        4
      ),

    continuity:
      round(
        continuity,
        4
      ),

    speechDensity:
      round(
        density,
        4
      ),

    consensus:
      round(
        consensus,
        4
      ),

    startStrength:
      round(
        startStrength,
        4
      ),

    endStrength:
      round(
        endStrength,
        4
      ),

    speechSegments:
      eventCount,

    score

  };

}


/* ======================================================
   CREATE 30 SECOND CANDIDATES
====================================================== */

function createVoiceCandidates(
  speechSegments,
  reports,
  duration
) {

  const candidates = [];


  if (
    duration <= 0
  ) {

    return candidates;

  }


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


  const balancedScores =
    reports
      .balanced
      .scores;


  const sensitiveScores =
    reports
      .sensitive
      .scores;


  const strictScores =
    reports
      .strict
      .scores;


  /*
  ------------------------------------------------------
  NORMAL SLIDING WINDOW
  ------------------------------------------------------
  */

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
      scoreCandidate(
        start,
        end,
        speechSegments,
        balancedScores,
        sensitiveScores,
        strictScores
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
  ------------------------------------------------------
  ALWAYS TEST FINAL WINDOW
  ------------------------------------------------------
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
          ) < 0.01
      );


    if (
      !exists
    ) {

      const finalCandidate =
        scoreCandidate(
          maxStart,
          maxStart +
            clipLength,
          speechSegments,
          balancedScores,
          sensitiveScores,
          strictScores
        );


      if (
        finalCandidate
      ) {

        candidates.push(
          finalCandidate
        );

      }

    }

  }


  /*
  ------------------------------------------------------
  SHORT VIDEO
  ------------------------------------------------------
  */

  if (
    candidates.length === 0
  ) {

    const candidate =
      scoreCandidate(
        0,
        clipLength,
        speechSegments,
        balancedScores,
        sensitiveScores,
        strictScores
      );


    if (
      candidate
    ) {

      candidates.push(
        candidate
      );

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
        existing => {

          const distance =
            Math.abs(
              candidate.start -
              existing.start
            );


          return (
            distance <
            separation
          );

        }
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
   ANALYZE VOICE
====================================================== */

async function analyzeVoice(
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
    "🎤 VOICE ENGINE MAX V5"
  );

  console.log(
    "MULTI-PASS SILERO SPEECH ANALYSIS"
  );

  console.log(
    "VIDEO DURATION:",
    videoDuration,
    "seconds"
  );

  console.log(
    "======================================================"
  );


  if (
    typeof progressCallback ===
    "function"
  ) {

    progressCallback(
      5
    );

  }


  let wavPath =
    null;


  try {

    /*
    ====================================================
    STEP 1
    ====================================================
    */

    wavPath =
      await extractVoiceAudio(
        videoPath
      );


    if (
      typeof progressCallback ===
      "function"
    ) {

      progressCallback(
        20
      );

    }


    /*
    ====================================================
    STEP 2
    MULTI-PASS SILERO
    ====================================================
    */

    const reports = {};


    for (
      let i = 0;
      i <
      VAD_PROFILES.length;
      i++
    ) {

      const profile =
        VAD_PROFILES[i];


      const result =
        await runSileroProfile(
          wavPath,
          profile
        );


      reports[
        profile.name
      ] =
        result;


      const progress =
        20 +
        (
          ((i + 1) /
            VAD_PROFILES.length)
          * 40
        );


      if (
        typeof progressCallback ===
        "function"
      ) {

        progressCallback(
          Math.round(
            progress
          )
        );

      }

    }


    /*
    ====================================================
    STEP 3
    BUILD SPEECH CONSENSUS
    ====================================================
    */

    const speechSegments =
      buildConsensusSegments(
        reports,
        videoDuration
      );


    console.log("");
    console.log(
      "[VOICE MAX] CONSENSUS SEGMENTS:",
      speechSegments.length
    );


    const totalSpeechTime =
      speechSegments.reduce(
        (
          total,
          segment
        ) =>
          total +
          segment.duration,
        0
      );


    /*
    ====================================================
    STEP 4
    CREATE CANDIDATES
    ====================================================
    */

    if (
      typeof progressCallback ===
      "function"
    ) {

      progressCallback(
        70
      );

    }


    const candidates =
      createVoiceCandidates(
        speechSegments,
        reports,
        videoDuration
      );


    console.log(
      "[VOICE MAX] CANDIDATES:",
      candidates.length
    );


    /*
    ====================================================
    STEP 5
    TOP 10
    ====================================================
    */

    const top =
      getTopSeparated(
        candidates,
        TOP_LIMIT,
        SEPARATION_SECONDS
      );


    /*
    ====================================================
    STEP 6
    BEST
    ====================================================
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


    /*
    ====================================================
    STEP 7
    GLOBAL STATISTICS
    ====================================================
    */

    const speechPercent =
      videoDuration > 0
        ? (
            totalSpeechTime /
            videoDuration
          ) * 100
        : 0;


    const sensitiveSegments =
      reports
        .sensitive
        .segments;


    const balancedSegments =
      reports
        .balanced
        .segments;


    const strictSegments =
      reports
        .strict
        .segments;


    /*
    ====================================================
    COMPLETE
    ====================================================
    */

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
      "🎤 VOICE ENGINE MAX V5 COMPLETE"
    );

    console.log(
      "Speech:",
      round(
        totalSpeechTime,
        2
      ),
      "sec"
    );

    console.log(
      "Speech:",
      round(
        speechPercent,
        2
      ),
      "%"
    );

    console.log(
      "Consensus segments:",
      speechSegments.length
    );

    console.log(
      "Candidates:",
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

    } else {

      console.log(
        "BEST: NONE"
      );

    }


    console.log(
      "======================================================"
    );


    /*
    ====================================================
    RETURN RESULT
    ====================================================
    */

    return {

      engine:
        "Voice Engine MAX V5",

      detector:
        "Silero VAD",

      detectorMode:
        "multi-threshold consensus",

      duration:
        round(
          videoDuration
        ),

      speechSegments:
        speechSegments,

      speechSegmentCount:
        speechSegments.length,

      totalSpeechTime:
        round(
          totalSpeechTime
        ),

      speechPercent:
        round(
          speechPercent,
          2
        ),

      profileStats: {

        sensitive: {

          threshold:
            VAD_PROFILES[0]
              .threshold,

          holdoffMs:
            VAD_PROFILES[0]
              .holdoffMs,

          rawSegmentCount:
            sensitiveSegments.length,

          scoreWindows:
            reports
              .sensitive
              .scores.length

        },

        balanced: {

          threshold:
            VAD_PROFILES[1]
              .threshold,

          holdoffMs:
            VAD_PROFILES[1]
              .holdoffMs,

          rawSegmentCount:
            balancedSegments.length,

          scoreWindows:
            reports
              .balanced
              .scores.length

        },

        strict: {

          threshold:
            VAD_PROFILES[2]
              .threshold,

          holdoffMs:
            VAD_PROFILES[2]
              .holdoffMs,

          rawSegmentCount:
            strictSegments.length,

          scoreWindows:
            reports
              .strict
              .scores.length

        }

      },

      candidatesAnalyzed:
        candidates.length,

      top:
        top,

      best:
        best,

      settings: {

        sampleRate:
          SAMPLE_RATE,

        clipDuration:
          CLIP_DURATION,

        windowStep:
          WINDOW_STEP,

        minSpeechDuration:
          MIN_SPEECH_DURATION,

        segmentGap:
          SEGMENT_GAP,

        topLimit:
          TOP_LIMIT,

        separationSeconds:
          SEPARATION_SECONDS,

        vadProfiles:
          VAD_PROFILES

      }

    };

  } finally {

    cleanupTempAudio(
      wavPath
    );

  }

}


/* ======================================================
   EXPORTS
====================================================== */

module.exports = {

  analyzeVoice,

  extractVoiceAudio,

  runSileroProfile,

  normalizeSegments,

  mergeSegments,

  createVoiceCandidates,

  getTopSeparated,

  calculateVoiceScore

};
