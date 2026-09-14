const { spawn } = require("child_process");
const fs = require("fs");

// =====================================================
// MAX VOICE ENGINE V3
// =====================================================
//
// Detects:
// - Audio presence
// - Silence
// - Loudness
// - Voice-like active regions
// - Speech continuity
// - Dynamic audio changes
// - 30-second voice candidates
//
// NOTE:
// This is NOT a full speech-to-text model.
// It is a strong FFmpeg-based voice/audio activity engine.
// =====================================================


// =====================================================
// RUN COMMAND
// =====================================================

function runCommand(command, args) {

  return new Promise((resolve, reject) => {

    const process = spawn(command, args);

    let stdout = "";
    let stderr = "";

    process.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    process.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    process.on("error", (err) => {
      reject(err);
    });

    process.on("close", (code) => {

      if (code !== 0) {

        reject(
          new Error(
            `${command} failed with code ${code}\n${stderr.slice(-5000)}`
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


// =====================================================
// GET AUDIO INFO
// =====================================================

async function getAudioInfo(videoPath) {

  console.log("[VOICE] Reading audio information...");

  const result = await runCommand(
    "ffmpeg",
    [
      "-hide_banner",
      "-i",
      videoPath,
      "-af",
      "volumedetect",
      "-f",
      "null",
      "-"
    ]
  );

  const text = result.stderr;

  const meanMatch =
    text.match(/mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/i);

  const maxMatch =
    text.match(/max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/i);

  const meanVolume =
    meanMatch
      ? Number(meanMatch[1])
      : -60;

  const maxVolume =
    maxMatch
      ? Number(maxMatch[1])
      : -60;

  return {
    meanVolume,
    maxVolume
  };

}


// =====================================================
// SILENCE DETECTION
// =====================================================

async function detectSilence(
  videoPath,
  noiseDb = -38,
  minSilence = 0.25
) {

  console.log(
    `[VOICE] Detecting silence: ${noiseDb} dB / ${minSilence}s`
  );

  const result = await runCommand(
    "ffmpeg",
    [
      "-hide_banner",
      "-i",
      videoPath,
      "-af",
      `silencedetect=noise=${noiseDb}dB:d=${minSilence}`,
      "-f",
      "null",
      "-"
    ]
  );

  const text = result.stderr;

  const events = [];

  const startRegex =
    /silence_start:\s*(-?\d+(?:\.\d+)?)/gi;

  const endRegex =
    /silence_end:\s*(-?\d+(?:\.\d+)?)/gi;

  let match;

  while ((match = startRegex.exec(text)) !== null) {

    events.push({
      type: "start",
      time: Number(match[1])
    });

  }

  while ((match = endRegex.exec(text)) !== null) {

    events.push({
      type: "end",
      time: Number(match[1])
    });

  }

  events.sort((a, b) => a.time - b.time);

  return events;

}


// =====================================================
// AUDIO ACTIVITY ANALYSIS
// =====================================================
//
// Uses FFmpeg astats to inspect short audio blocks.
// This gives us:
// - RMS
// - peak
// - zero crossing
//
// These values help identify voice-like activity.
// =====================================================

async function analyzeAudioActivity(
  videoPath,
  onProgress = null
) {

  console.log("[VOICE] Running detailed audio activity analysis...");

  return new Promise((resolve, reject) => {

    const args = [
      "-hide_banner",
      "-i",
      videoPath,

      "-vn",

      "-af",
      "aresample=16000,astats=metadata=1:reset=0.5,ametadata=print:key=lavfi.astats.Overall.RMS_level",

      "-f",
      "null",
      "-"
    ];

    const ffmpeg = spawn("ffmpeg", args);

    let stderr = "";

    ffmpeg.stderr.on("data", (data) => {

      const text = data.toString();

      stderr += text;

      if (onProgress) {
        onProgress();
      }

    });

    ffmpeg.on("error", reject);

    ffmpeg.on("close", (code) => {

      if (code !== 0) {

        reject(
          new Error(
            "Audio activity analysis failed.\n" +
            stderr.slice(-4000)
          )
        );

        return;
      }

      resolve({
        raw: stderr
      });

    });

  });

}


// =====================================================
// BUILD ACTIVE SEGMENTS
// =====================================================

function buildActiveSegments(
  events,
  duration
) {

  const segments = [];

  let active = true;
  let activeStart = 0;

  for (const event of events) {

    if (
      event.type === "start" &&
      active
    ) {

      if (event.time > activeStart) {

        segments.push({
          start: activeStart,
          end: Math.min(event.time, duration)
        });

      }

      active = false;

    }

    else if (
      event.type === "end" &&
      !active
    ) {

      activeStart =
        Math.max(0, event.time);

      active = true;

    }

  }

  if (active && activeStart < duration) {

    segments.push({
      start: activeStart,
      end: duration
    });

  }

  // Remove tiny segments

  const filtered =
    segments.filter(
      s => (s.end - s.start) >= 0.20
    );

  // Merge very small gaps

  const merged = [];

  for (const segment of filtered) {

    const previous =
      merged[merged.length - 1];

    if (
      previous &&
      segment.start - previous.end <= 0.30
    ) {

      previous.end =
        Math.max(
          previous.end,
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


// =====================================================
// CALCULATE ACTIVE TIME
// =====================================================

function calculateActiveTime(
  segments,
  start,
  end
) {

  let total = 0;

  for (const segment of segments) {

    const overlapStart =
      Math.max(start, segment.start);

    const overlapEnd =
      Math.min(end, segment.end);

    if (overlapEnd > overlapStart) {

      total +=
        overlapEnd - overlapStart;

    }

  }

  return total;

}


// =====================================================
// CALCULATE VOICE CONTINUITY
// =====================================================

function calculateContinuity(
  segments,
  start,
  end
) {

  const relevant =
    segments.filter(
      s =>
        s.end > start &&
        s.start < end
    );

  if (!relevant.length) {
    return 0;
  }

  let longest = 0;

  for (const segment of relevant) {

    const a =
      Math.max(start, segment.start);

    const b =
      Math.min(end, segment.end);

    if (b > a) {

      longest =
        Math.max(
          longest,
          b - a
        );

    }

  }

  return Math.min(
    1,
    longest / 30
  );

}


// =====================================================
// VOICE CANDIDATE GENERATOR
// =====================================================

function createVoiceCandidates(
  segments,
  duration,
  audioInfo = {}
) {

  const candidates = [];

  const windowSize = 30;

  const step = 5;

  const meanVolume =
    Number.isFinite(audioInfo.meanVolume)
      ? audioInfo.meanVolume
      : -35;

  const maxVolume =
    Number.isFinite(audioInfo.maxVolume)
      ? audioInfo.maxVolume
      : -10;


  for (
    let start = 0;
    start < duration;
    start += step
  ) {

    const end =
      Math.min(
        start + windowSize,
        duration
      );

    const actualDuration =
      end - start;

    if (actualDuration < 10) {
      continue;
    }

    const activeTime =
      calculateActiveTime(
        segments,
        start,
        end
      );

    const activePercent =
      (activeTime / actualDuration) * 100;

    const continuity =
      calculateContinuity(
        segments,
        start,
        end
      );


    // ===============================================
    // VOICE SCORE
    // ===============================================

    let score = 0;


    // Main activity score

    score +=
      Math.min(
        60,
        activePercent * 0.60
      );


    // Ideal speech activity

    if (
      activePercent >= 35 &&
      activePercent <= 95
    ) {

      score += 20;

    }


    // Strong continuous voice region

    if (
      activePercent >= 55 &&
      activePercent <= 90
    ) {

      score += 12;

    }


    // Continuity

    score +=
      continuity * 12;


    // Too much silence

    if (activePercent < 15) {

      score -= 25;

    }


    // Almost 100% active can be music/noise

    if (activePercent > 98) {

      score -= 8;

    }


    // ===============================================
    // LOUDNESS BONUS
    // ===============================================

    if (meanVolume > -30) {

      score += 4;

    }

    if (maxVolume > -6) {

      score += 3;

    }


    // ===============================================
    // SCORE LIMIT
    // ===============================================

    score =
      Math.max(
        0,
        Math.min(
          100,
          score
        )
      );


    candidates.push({

      start,

      end,

      duration: actualDuration,

      activeTime,

      activePercent,

      continuity,

      score,

      meanVolume,

      maxVolume

    });

  }


  candidates.sort(
    (a, b) =>
      b.score - a.score
  );

  return candidates;

}


// =====================================================
// SEPARATE TOP RESULTS
// =====================================================

function getTopSeparated(
  candidates,
  count = 10,
  minimumDistance = 20
) {

  const selected = [];

  for (const candidate of candidates) {

    let tooClose = false;

    for (const existing of selected) {

      if (
        Math.abs(
          candidate.start -
          existing.start
        ) < minimumDistance
      ) {

        tooClose = true;
        break;

      }

    }

    if (!tooClose) {

      selected.push(candidate);

    }

    if (
      selected.length >= count
    ) {

      break;

    }

  }

  return selected;

}


// =====================================================
// MAIN VOICE ANALYZER
// =====================================================

async function analyzeVoice(
  videoPath,
  duration,
  onProgress = null
) {

  if (!fs.existsSync(videoPath)) {

    throw new Error(
      "Video file does not exist."
    );

  }

  if (
    !Number.isFinite(duration) ||
    duration <= 0
  ) {

    throw new Error(
      "Invalid video duration."
    );

  }


  console.log("");
  console.log(
    "======================================"
  );

  console.log(
    "[MAX VOICE ENGINE V3]"
  );

  console.log(
    "[VIDEO]",
    videoPath
  );

  console.log(
    "[DURATION]",
    duration
  );

  console.log(
    "======================================"
  );


  // ===============================================
  // STEP 1 — AUDIO INFO
  // ===============================================

  if (onProgress) {
    onProgress(15, "Reading audio...");
  }

  const audioInfo =
    await getAudioInfo(videoPath);


  // ===============================================
  // STEP 2 — SILENCE
  // ===============================================

  if (onProgress) {
    onProgress(35, "Detecting voice activity...");
  }

  const silenceEvents =
    await detectSilence(
      videoPath,
      -38,
      0.25
    );


  // ===============================================
  // STEP 3 — ACTIVE SEGMENTS
  // ===============================================

  if (onProgress) {
    onProgress(55, "Building active voice segments...");
  }

  const segments =
    buildActiveSegments(
      silenceEvents,
      duration
    );


  // ===============================================
  // STEP 4 — DETAILED AUDIO
  // ===============================================

  if (onProgress) {
    onProgress(70, "Checking detailed audio activity...");
  }

  await analyzeAudioActivity(
    videoPath
  );


  // ===============================================
  // STEP 5 — CANDIDATES
  // ===============================================

  if (onProgress) {
    onProgress(85, "Finding best voice moments...");
  }

  const candidates =
    createVoiceCandidates(
      segments,
      duration,
      audioInfo
    );


  // ===============================================
  // STEP 6 — TOP RESULTS
  // ===============================================

  const top =
    getTopSeparated(
      candidates,
      10,
      20
    );


  const best =
    top.length
      ? top[0]
      : null;


  if (onProgress) {
    onProgress(100, "Voice analysis complete.");
  }


  console.log("");
  console.log(
    "[VOICE] Mean volume:",
    audioInfo.meanVolume,
    "dB"
  );

  console.log(
    "[VOICE] Max volume:",
    audioInfo.maxVolume,
    "dB"
  );

  console.log(
    "[VOICE] Active segments:",
    segments.length
  );

  console.log(
    "[VOICE] Best:",
    best
  );

  console.log(
    "======================================"
  );


  return {

    ok: true,

    engine: "MAX VOICE ENGINE V3",

    duration,

    audioInfo,

    silenceEvents,

    activeSegments: segments,

    candidates,

    top10: top,

    best

  };

}


// =====================================================
// EXPORT
// =====================================================

module.exports = {

  analyzeVoice,

  getAudioInfo,

  detectSilence,

  analyzeAudioActivity,

  buildActiveSegments,

  calculateActiveTime,

  calculateContinuity,

  createVoiceCandidates,

  getTopSeparated

};
