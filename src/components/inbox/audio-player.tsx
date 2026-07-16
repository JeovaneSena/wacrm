"use client";

import { useEffect, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";
import { cn } from "@/lib/utils";

const SPEEDS = [1, 1.5, 2] as const;

function fmt(seconds: number): string {
  if (!Number.isFinite(seconds)) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * Custom voice-note player. Replaces the native `<audio controls>`
 * element — its playback-speed option was buried in Chrome's overflow
 * ("⋮") menu, which agents didn't find. Speed is a first-class button
 * here instead. Wraps a plain hidden `<audio>` for actual playback.
 */
export function AudioPlayer({ src }: { src: string }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [speedIndex, setSpeedIndex] = useState(0);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onTime = () => setCurrentTime(audio.currentTime);
    const onLoaded = () => setDuration(audio.duration);
    const onEnd = () => setPlaying(false);
    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("loadedmetadata", onLoaded);
    audio.addEventListener("ended", onEnd);
    return () => {
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("loadedmetadata", onLoaded);
      audio.removeEventListener("ended", onEnd);
    };
  }, []);

  function togglePlay() {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) {
      audio.pause();
    } else {
      void audio.play();
    }
    setPlaying(!playing);
  }

  function cycleSpeed() {
    const next = (speedIndex + 1) % SPEEDS.length;
    setSpeedIndex(next);
    if (audioRef.current) audioRef.current.playbackRate = SPEEDS[next];
  }

  function seek(e: React.ChangeEvent<HTMLInputElement>) {
    const audio = audioRef.current;
    const value = Number(e.target.value);
    if (audio) audio.currentTime = value;
    setCurrentTime(value);
  }

  return (
    <div className="flex w-full max-w-60 items-center gap-1.5 rounded-lg bg-muted/40 px-2 py-1.5">
      <audio ref={audioRef} src={src} preload="metadata" className="hidden" />
      <button
        type="button"
        onClick={togglePlay}
        aria-label={playing ? "Pause" : "Play"}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground"
      >
        {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5 translate-x-px" />}
      </button>
      <input
        type="range"
        min={0}
        max={duration || 0}
        step={0.1}
        value={currentTime}
        onChange={seek}
        className="h-1 min-w-0 flex-1 accent-primary"
        aria-label="Seek"
      />
      <span className="w-8 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground">
        {fmt(playing || currentTime > 0 ? currentTime : duration)}
      </span>
      <button
        type="button"
        onClick={cycleSpeed}
        className={cn(
          "w-8 shrink-0 rounded px-1 py-0.5 text-center text-[10px] font-semibold tabular-nums",
          speedIndex > 0
            ? "bg-primary/20 text-primary"
            : "bg-transparent text-muted-foreground hover:bg-muted",
        )}
      >
        {SPEEDS[speedIndex]}x
      </button>
    </div>
  );
}
