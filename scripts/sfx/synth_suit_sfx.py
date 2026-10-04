#!/usr/bin/env python3
"""
Procedural sound design for the Mark III suit-up and doffing.

Every effect is synthesised from physical models rather than library
samples — modal resonators for struck armor plate, filtered noise
transients for clicks, latches and pressure jets, harmonic motor models for
servos, drills and the arc reactor — then put in a small, dry workshop room.

Transients are placed at exact offsets: the director mix
(src/audio/choreTimeline.seed.json) pins each suit-up beat to an onset
inside its clip (SFX_ONSETS in suitUpChoreography.ts, plus the ratchet and
drill click trains), so a file built for a clip keeps those onsets.

Usage:  python3 scripts/sfx/synth_suit_sfx.py   (writes public/sounds/mk3-*.mp3)
Needs numpy, scipy and ffmpeg on PATH.
"""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import wave

import numpy as np
from scipy import signal

SR = 44100
RNG = np.random.default_rng(3)
OUT = os.path.join(os.path.dirname(__file__), '..', '..', 'public', 'sounds')

# ── Primitives ────────────────────────────────────────────────────────────


def n(d: float) -> int:
    return max(1, int(round(d * SR)))


def tt(d: float) -> np.ndarray:
    return np.arange(n(d)) / SR


def silence(d: float) -> np.ndarray:
    return np.zeros(n(d))


def band(x: np.ndarray, lo: float | None, hi: float | None, order: int = 4) -> np.ndarray:
    if lo and hi:
        sos = signal.butter(order, [lo, hi], 'bandpass', fs=SR, output='sos')
    elif lo:
        sos = signal.butter(order, lo, 'highpass', fs=SR, output='sos')
    else:
        sos = signal.butter(order, hi, 'lowpass', fs=SR, output='sos')
    return signal.sosfilt(sos, x)


def noise(d: float) -> np.ndarray:
    return RNG.standard_normal(n(d))


def env_exp(d: float, decay: float, attack: float = 0.0005) -> np.ndarray:
    t = tt(d)
    a = np.clip(t / max(attack, 1e-5), 0, 1)
    return a * np.exp(-t / decay)


def env_ar(d: float, attack: float, release: float, curve: float = 1.0) -> np.ndarray:
    t = tt(d)
    a = np.clip(t / max(attack, 1e-5), 0, 1) ** curve
    r = np.clip((d - t) / max(release, 1e-5), 0, 1) ** curve
    return a * r


def place(buf: np.ndarray, x: np.ndarray, at: float, gain: float = 1.0) -> np.ndarray:
    i = n(at) if at > 0 else 0
    end = min(len(buf), i + len(x))
    if end > i:
        seg = x[: end - i].copy()
        # Never cut a ringing tail dead (a hard stop clicks)
        f = min(len(seg), n(0.006))
        seg[-f:] *= np.linspace(1, 0, f)
        buf[i:end] += gain * seg
    return buf


def norm(x: np.ndarray) -> np.ndarray:
    p = np.max(np.abs(x)) or 1.0
    return x / p


def modal(d: float, modes: list[tuple[float, float, float]], strike: float = 1.0) -> np.ndarray:
    """Struck plate: damped sinusoids (freq Hz, decay s, gain)."""
    t = tt(d)
    out = np.zeros_like(t)
    for f, dec, g in modes:
        ph = RNG.uniform(0, 2 * np.pi)
        out += g * np.sin(2 * np.pi * f * t + ph) * np.exp(-t / dec)
    # Strike stiffness: a short noise excitation through the same body
    exc = band(noise(0.004), 1500, 12000) * env_exp(0.004, 0.0012) * strike
    out[: len(exc)] += exc * 0.6
    return out


# Inharmonic ratios of a stiff curved plate (measured-ish, not a bell)
PLATE = [1.0, 1.58, 2.13, 2.31, 2.71, 3.02, 3.58, 4.17, 4.93, 5.6]


def armor_hit(base: float, weight: float = 1.0, ring: float = 0.35, bright: float = 1.0, d: float = 1.2) -> np.ndarray:
    """
    A heavy armor plate seating: body thump, the plate's low modes, a dense
    cloud of high modes (thick curved plate + fasteners rattling) and a
    broadband contact crack.
    """
    modes = []
    for i, r in enumerate(PLATE):
        f = base * r * RNG.uniform(0.985, 1.015)
        dec = ring * (1.0 / (1 + 0.55 * i)) * RNG.uniform(0.8, 1.2)
        modes.append((f, dec, 0.9 ** i))
    # Dense upper modes, log-spaced to ~9 kHz, shorter the higher they sit
    for f in np.geomspace(base * 5.5, 9000, 34) * RNG.uniform(0.97, 1.03, 34):
        dec = ring * 0.5 * (base * 5.5 / f) ** 0.6 * RNG.uniform(0.6, 1.4)
        modes.append((f, dec, 0.22 * bright * (base * 5.5 / f) ** 0.35 * RNG.uniform(0.5, 1.0)))
    x = modal(d, modes) * 0.45
    t = tt(d)
    # Body: a pitched-down sine thump
    f0 = 95 * weight ** 0.3
    thump = np.sin(2 * np.pi * np.cumsum(f0 * (0.55 + 0.45 * np.exp(-t / 0.03))) / SR) * np.exp(-t / (0.07 * weight))
    x += thump * 0.9 * weight
    # Contact crack + a short rattle of the joint
    crack = band(noise(d), 600, 9500) * env_exp(d, 0.018 + 0.02 * weight, 0.0004)
    x += crack * 0.55 * bright
    return x


def click(bright: float = 1.0, d: float = 0.03, f: float = 3200) -> np.ndarray:
    """Small latch / ratchet pawl click: noise tick + a tiny ping."""
    x = band(noise(d), 1800, 11000) * env_exp(d, 0.0016) * bright
    x += modal(d, [(f, 0.012, 0.35), (f * 1.73, 0.007, 0.2)], strike=0.0)
    return x


def motor(d: float, f0: float, f1: float, harm: int = 14, gear: float = 9.0, rough: float = 0.15,
          lo: float = 120, hi: float = 5000, curve: str = 'exp') -> np.ndarray:
    """Electric servo / gear motor with a pitch glide f0 → f1 (Hz)."""
    t = tt(d)
    u = t / d
    if curve == 'exp':
        f = f0 * (f1 / f0) ** u
    else:
        f = f0 + (f1 - f0) * (1 - (1 - u) ** 2)
    jitter = 1 + 0.004 * band(noise(d), None, 30, 2) * 40
    ph = 2 * np.pi * np.cumsum(f * jitter) / SR
    x = np.zeros_like(t)
    for k in range(1, harm + 1):
        x += np.sin(k * ph + k * 0.7) / k ** 0.9
    # Gear mesh: amplitude ripple at a multiple of the shaft rate
    x *= 1 + 0.35 * np.sin(gear * ph)
    x += rough * band(noise(d), 800, 6000) * (1 + np.sin(gear * ph)) * 0.5
    return band(x, lo, hi)


def jet(d: float, lo: float = 900, hi: float = 7000, decay: float = 0.12, attack: float = 0.003) -> np.ndarray:
    """Pressure jet / pneumatic blast: shaped noise, sharp front."""
    x = band(noise(d), lo, hi) * env_exp(d, decay, attack)
    return x


def room(x: np.ndarray, rt: float = 0.45, mix: float = 0.16, pre: float = 0.011, tone: float = 5000) -> np.ndarray:
    """Small dry workshop: early reflections + a short damped tail."""
    L = n(rt * 1.6)
    t = np.arange(L) / SR
    ir = RNG.standard_normal(L) * np.exp(-6.9 * t / rt)
    ir = band(ir, 150, tone, 2)
    for dt, g in [(0.007, 0.5), (0.013, 0.35), (0.021, 0.28), (0.034, 0.18)]:
        ir[n(dt)] += g * 8
    ir[: n(pre)] = 0
    ir /= np.sqrt(np.sum(ir ** 2))
    wet = signal.fftconvolve(x, ir)
    dry = np.concatenate([x, np.zeros(len(wet) - len(x))])
    return dry + mix * wet * 0.6


def finish(x: np.ndarray, peak: float = 0.89, tail: float = 0.0) -> np.ndarray:
    x = np.concatenate([x, np.zeros(n(tail))]) if tail else x
    # Trim trailing near-silence
    a = np.abs(x)
    thr = np.max(a) * 10 ** (-62 / 20)
    idx = np.where(a > thr)[0]
    if len(idx):
        x = x[: min(len(x), idx[-1] + n(0.02))]
    x = np.tanh(1.2 * norm(x)) / np.tanh(1.2)
    fade = min(len(x), n(0.01))
    x[-fade:] *= np.linspace(1, 0, fade)
    return x * peak


def write(name: str, x: np.ndarray, min_len: float = 0.0) -> float:
    if min_len and len(x) < n(min_len):
        x = np.concatenate([x, np.zeros(n(min_len) - len(x))])
    os.makedirs(OUT, exist_ok=True)
    pcm = (np.clip(x, -1, 1) * 32767).astype('<i2')
    with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as f:
        wav = f.name
    with wave.open(wav, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())
    mp3 = os.path.join(OUT, name)
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', wav, '-codec:a', 'libmp3lame', '-q:a', '3', mp3], check=True)
    os.unlink(wav)
    return len(x) / SR


# ── Assembly: director mix (onsets fixed by SFX_ONSETS) ───────────────────


def boot_lift() -> np.ndarray:
    """Floor lift raises the boots; ankle clamps bite at 0.40 / 0.58; hatch shuts at 1.33."""
    x = silence(2.6)
    lift = motor(0.6, 55, 120, harm=10, gear=6, rough=0.08, lo=40, hi=2200, curve='lin') * env_ar(0.6, 0.12, 0.25)
    place(x, lift, 0.0, 0.5)
    place(x, armor_hit(150, weight=1.3, ring=0.25, bright=0.7), 0.40, 1.0)
    place(x, armor_hit(160, weight=1.2, ring=0.25, bright=0.7), 0.58, 0.95)
    for k, at in enumerate([0.43, 0.61]):
        place(x, click(0.8, f=2600 + 300 * k), at + 0.03, 0.35)
    # Lift plates fold back into the deck, lid seats
    place(x, motor(0.5, 140, 70, harm=8, rough=0.05, lo=50, hi=1800) * env_ar(0.5, 0.05, 0.2), 0.85, 0.3)
    place(x, armor_hit(110, weight=1.0, ring=0.18, bright=0.4), 1.33, 0.55)
    return room(x)


def clamshell() -> np.ndarray:
    """Clamshell fixture slams on at 0.045; the ratchet pawl clicks it tight."""
    x = silence(1.6)
    place(x, armor_hit(210, weight=1.15, ring=0.32, bright=0.9), 0.045, 1.0)
    for i, at in enumerate([0.18, 0.273, 0.377, 0.47, 0.563, 0.644]):
        place(x, click(1.0 - 0.06 * i, f=2900 + 90 * i), at, 0.55 + 0.04 * i)
    # Drive motor whirs between the clicks
    place(x, motor(0.5, 260, 210, harm=10, gear=12, rough=0.1, lo=200, hi=4500) * env_ar(0.5, 0.04, 0.12), 0.16, 0.12)
    return room(x)


def waist_seal() -> np.ndarray:
    """Pelvis halves draw together (servo) and seal at 0.656 with a pneumatic chuff."""
    x = silence(1.6)
    place(x, motor(0.55, 180, 320, harm=12, gear=10, rough=0.08) * env_ar(0.55, 0.15, 0.05), 0.1, 0.35)
    place(x, armor_hit(185, weight=1.1, ring=0.3, bright=0.8), 0.656, 1.0)
    place(x, jet(0.3, 500, 3500, decay=0.06), 0.66, 0.35)
    return room(x)


def torso_servo() -> np.ndarray:
    """Torso cell spins up at 0.02; back plate locks at 1.40, housing at 1.718."""
    x = silence(2.4)
    place(x, motor(0.35, 90, 240, harm=14, gear=11, rough=0.1) * env_ar(0.35, 0.02, 0.05), 0.02, 0.4)
    run = motor(1.9, 240, 210, harm=14, gear=11, rough=0.1) * env_ar(1.9, 0.05, 0.4)
    run *= 1 + 0.25 * np.sin(2 * np.pi * 1.3 * tt(1.9))
    place(x, run, 0.3, 0.3)
    place(x, armor_hit(240, weight=1.0, ring=0.3, bright=0.9), 1.40, 0.95)
    place(x, armor_hit(300, weight=0.9, ring=0.28, bright=1.0), 1.718, 0.85)
    place(x, click(0.9, f=3400), 1.75, 0.4)
    return room(x)


def plate_seat() -> np.ndarray:
    """Lower back plate seats at 0.82, abdomen at 1.46 (each with a short slide-in)."""
    x = silence(2.2)
    for at, base in [(0.82, 230), (1.46, 270)]:
        place(x, motor(0.3, 300, 380, harm=10, gear=9, rough=0.08) * env_ar(0.3, 0.08, 0.04), at - 0.3, 0.22)
        place(x, armor_hit(base, weight=0.95, ring=0.3), at, 0.95)
        place(x, click(0.8), at + 0.06, 0.3)
    return room(x)


def chest_slam() -> np.ndarray:
    """Both pecs slam home over the housing at 0.17: the biggest hit of the build."""
    x = silence(1.6)
    place(x, jet(0.15, 200, 1800, decay=0.05, attack=0.08) * 0.4, 0.03)  # air pushed out ahead
    place(x, armor_hit(120, weight=2.0, ring=0.55, bright=1.0, d=1.4), 0.17, 1.0)
    place(x, armor_hit(175, weight=1.2, ring=0.4, bright=0.8, d=1.2), 0.172, 0.6)
    t = tt(0.6)
    sub = np.sin(2 * np.pi * 42 * t) * np.exp(-t / 0.18)
    place(x, sub, 0.17, 0.8)
    return room(x, mix=0.2)


def reactor() -> np.ndarray:
    """Arc reactor catches at 0.08 and blooms at 0.17, settling to a hum."""
    x = silence(1.6)
    t = tt(1.5)
    # Charge: a fast upward electrical sweep into the catch
    sweep_d = 0.09
    ts = tt(sweep_d)
    f = 300 * (2400 / 300) ** (ts / sweep_d)
    ch = np.sin(2 * np.pi * np.cumsum(f) / SR) * (ts / sweep_d) ** 2
    place(x, ch, 0.0, 0.35)
    place(x, band(noise(0.03), 2000, 12000) * env_exp(0.03, 0.006), 0.08, 0.6)
    # Bloom: a chord of detuned partials swelling at 0.17
    hum = np.zeros_like(t)
    for fr, g in [(110, 1.0), (220.6, 0.6), (330.3, 0.35), (440.8, 0.3), (659, 0.15), (1320, 0.08)]:
        hum += g * np.sin(2 * np.pi * fr * t + RNG.uniform(0, 6))
    hum *= (1 + 0.15 * np.sin(2 * np.pi * 7 * t))
    e = np.clip((t - 0.0) / 0.09, 0, 1) ** 2 * (0.35 + 0.65 * np.exp(-np.maximum(0, t - 0.09) / 0.25))
    e *= np.clip((1.5 - t) / 0.5, 0, 1)
    place(x, hum * e, 0.08, 0.6)
    crackle = band(noise(0.4), 3000, 12000) * (RNG.random(n(0.4)) > 0.985) * env_exp(0.4, 0.12)
    place(x, crackle, 0.12, 0.8)
    return room(x, mix=0.14)


def pauldron() -> np.ndarray:
    """Shoulder caps drop on: left at 0.43, right at 0.73."""
    x = silence(1.7)
    for at, base in [(0.43, 255), (0.73, 240)]:
        place(x, armor_hit(base, weight=1.0, ring=0.38, bright=1.0), at, 0.95)
        place(x, click(0.7, f=3600), at + 0.05, 0.3)
    return room(x)


def arm_servo_bed() -> np.ndarray:
    """Tonal servo bed under the arm fitting: shoulder drives moving the arms (no hiss)."""
    d = 6.2
    t = tt(d)
    x = motor(d, 150, 150, harm=12, gear=8, rough=0.03, lo=90, hi=3000)
    # Moves: swells where the arms reposition
    sw = np.zeros_like(t)
    for c, w in [(0.4, 0.5), (1.6, 0.6), (2.7, 0.5), (4.0, 0.7), (5.3, 0.5)]:
        sw += np.exp(-((t - c) / w) ** 2)
    x *= 0.25 + 0.75 * sw / sw.max()
    x *= env_ar(d, 0.4, 1.2)
    return room(x, mix=0.1)


def arm_clamp() -> np.ndarray:
    """Upper-arm clamshells: left at 0.02, right at 0.50, each cinched with two clicks."""
    x = silence(1.3)
    for at in (0.02, 0.5):
        place(x, armor_hit(280, weight=0.9, ring=0.26, bright=0.9), at, 0.9)
        for k in range(2):
            place(x, click(0.9, f=3100 + 200 * k), at + 0.09 + 0.07 * k, 0.4)
    return room(x)


def drill() -> np.ndarray:
    """Nut runner screws the forearm sleeves home: L run from 0.29, R run from 0.63."""
    x = silence(1.3)
    for start, end, bites in [(0.29, 0.6, [0.319, 0.441, 0.575]), (0.63, 1.0, [0.697, 0.784, 0.871, 0.952])]:
        d = end - start
        m = motor(d, 420, 520, harm=16, gear=7, rough=0.2, lo=250, hi=7000) * env_ar(d, 0.015, 0.03)
        # Load: each bite drags the motor down for an instant
        t = tt(d)
        load = np.ones_like(t)
        for b in bites:
            load -= 0.45 * np.exp(-((t - (b - start)) / 0.012) ** 2)
        place(x, m * load, start, 0.4)
        for b in bites:
            place(x, click(1.0, f=2600), b, 0.55)
            place(x, armor_hit(520, weight=0.4, ring=0.06, bright=0.6, d=0.15), b, 0.22)
    return room(x)


def helmet_seat() -> np.ndarray:
    """Helmet lowers on (servo + building resonance) and seats with a crest at 1.02."""
    x = silence(2.5)
    t = tt(1.02)
    m = motor(1.0, 200, 160, harm=12, gear=10, rough=0.05) * np.clip(t[: n(1.0)] / 0.3, 0, 1)
    place(x, m, 0.02, 0.25)
    # Resonance swells into the seat (the shell rings sympathetically)
    rs = np.zeros(n(1.02))
    tr = tt(1.02)
    for fr, g in [(330, 1.0), (523, 0.5), (781, 0.35)]:
        rs += g * np.sin(2 * np.pi * fr * tr)
    rs *= (tr / 1.02) ** 3
    place(x, rs, 0.0, 0.18)
    place(x, armor_hit(330, weight=1.0, ring=0.6, bright=1.0, d=1.4), 1.02, 0.95)
    place(x, click(0.8, f=3800), 1.07, 0.3)
    return room(x, mix=0.2)


def gauntlet() -> np.ndarray:
    """Gauntlets snap on: left at 0.24, right at 0.38."""
    x = silence(1.0)
    for at, base in [(0.24, 380), (0.38, 360)]:
        place(x, armor_hit(base, weight=0.7, ring=0.2, bright=1.1, d=0.6), at, 0.85)
        place(x, click(1.0, f=4200), at + 0.03, 0.45)
    return room(x)


def faceplate() -> np.ndarray:
    """Arms lock at the sides and the faceplate latch releases at 0.813; the mask slams at 1.085."""
    x = silence(2.6)
    place(x, armor_hit(150, weight=1.2, ring=0.2, bright=0.5), 0.813, 0.7)
    place(x, click(1.0, f=3000), 0.813, 0.6)
    # Hinge servo swings the mask down
    place(x, motor(0.26, 380, 260, harm=12, gear=9, rough=0.08) * env_ar(0.26, 0.02, 0.03), 0.83, 0.35)
    place(x, armor_hit(420, weight=1.0, ring=0.7, bright=1.2, d=1.6), 1.085, 1.0)
    place(x, armor_hit(260, weight=1.0, ring=0.35, bright=0.6, d=1.0), 1.087, 0.5)
    place(x, click(1.0, f=4400), 1.12, 0.45)
    return room(x, mix=0.2)


def vent() -> np.ndarray:
    """Helmet / collar pressure vent at 0.1: a hard downward blast, quick to die."""
    x = silence(1.1)
    place(x, click(0.9, f=2400), 0.095, 0.5)
    place(x, jet(0.9, 1200, 9000, decay=0.1, attack=0.004), 0.1, 0.85)
    place(x, jet(0.5, 300, 1500, decay=0.08, attack=0.002), 0.1, 0.5)
    return room(x, mix=0.12)


# ── Assembly: action layer ─────────────────────────────────────────────────


def arm_move() -> np.ndarray:
    """A robot arm sets off: joint servos spin up, cruise, settle."""
    d = 0.9
    x = motor(d, 170, 260, harm=14, gear=9, rough=0.06, curve='lin') * env_ar(d, 0.08, 0.3)
    x += 0.5 * motor(d, 340, 420, harm=8, gear=13, rough=0.03) * env_ar(d, 0.12, 0.35)
    return room(x, mix=0.1)


def grip() -> np.ndarray:
    """Gripper jaws close on a part: short servo, firm stop."""
    x = silence(0.35)
    place(x, motor(0.12, 600, 420, harm=10, gear=9, rough=0.1) * env_ar(0.12, 0.01, 0.02), 0.0, 0.5)
    place(x, armor_hit(700, weight=0.4, ring=0.06, bright=1.0, d=0.2), 0.12, 0.7)
    return room(x, mix=0.1)


def release() -> np.ndarray:
    """Gripper opens: pawl click and a short servo back-off."""
    x = silence(0.3)
    place(x, click(0.9, f=3600), 0.0, 0.8)
    place(x, motor(0.1, 450, 620, harm=10, gear=9, rough=0.08) * env_ar(0.1, 0.01, 0.03), 0.02, 0.35)
    return room(x, mix=0.08)


def stand_sink() -> np.ndarray:
    """Empty parts stand telescopes down through its floor port."""
    d = 1.0
    x = motor(d, 140, 90, harm=10, gear=6, rough=0.06, lo=60, hi=2500) * env_ar(d, 0.05, 0.25)
    # Telescoping stages knock as each section nests
    for at in (0.3, 0.55, 0.8):
        place(x, armor_hit(260, weight=0.4, ring=0.05, bright=0.4, d=0.15), at, 0.25)
    return room(x, mix=0.12)


def port_lid() -> np.ndarray:
    """Floor port lid shuts flush."""
    x = silence(0.5)
    place(x, armor_hit(140, weight=0.9, ring=0.12, bright=0.4, d=0.45), 0.01, 1.0)
    return room(x, mix=0.12)


def arm_stow() -> np.ndarray:
    """Arm folds and sinks into the ring trench."""
    d = 2.0
    x = motor(d, 220, 110, harm=12, gear=8, rough=0.05) * env_ar(d, 0.1, 0.7)
    place(x, armor_hit(120, weight=1.0, ring=0.12, bright=0.3, d=0.4), 1.9, 0.5)
    return room(x, mix=0.12)


def rivet() -> np.ndarray:
    """Riveter strike: pneumatic hammer blow with a hot crackle."""
    x = silence(0.45)
    place(x, jet(0.05, 400, 3000, decay=0.012), 0.0, 0.35)
    place(x, armor_hit(600, weight=0.6, ring=0.08, bright=1.2, d=0.3), 0.012, 0.8)
    cr = band(noise(0.3), 2500, 12000) * (RNG.random(n(0.3)) > 0.97) * env_exp(0.3, 0.07)
    place(x, cr, 0.02, 1.0)
    return room(x, mix=0.1)


def sparks() -> np.ndarray:
    """Electrical arc crackle as a clamp shorts across its contacts."""
    d = 0.6
    pops = (RNG.random(n(d)) > 0.975) * RNG.uniform(0.3, 1, n(d))
    x = band(pops * RNG.standard_normal(n(d)), 2000, 13000) * env_exp(d, 0.14)
    x += 0.3 * band(noise(d), 4000, 12000) * env_exp(d, 0.03)
    return room(x, mix=0.08)


# ── Doffing ───────────────────────────────────────────────────────────────


def power_down() -> np.ndarray:
    """Systems to standby: relays drop out, the reactor whine sags down."""
    d = 1.5
    t = tt(d)
    f = 880 * (180 / 880) ** (t / d) ** 0.7
    whine = np.zeros_like(t)
    ph = 2 * np.pi * np.cumsum(f) / SR
    for k, g in [(1, 1.0), (2, 0.4), (3, 0.2)]:
        whine += g * np.sin(k * ph)
    whine *= np.exp(-t / 0.6) * np.clip(t / 0.02, 0, 1)
    x = whine * 0.5
    for at, b in [(0.0, 1.0), (0.09, 0.8), (0.21, 0.7)]:  # relay clunks with the eye flicker
        place(x, click(b, f=1800), at, 0.7)
        place(x, armor_hit(900, weight=0.2, ring=0.03, bright=0.6, d=0.1), at, 0.28)
    return room(x, mix=0.12)


def latch() -> np.ndarray:
    """Faceplate seal unlatches: sharp double clack."""
    x = silence(0.3)
    place(x, click(1.0, f=3300), 0.0, 1.0)
    place(x, armor_hit(520, weight=0.5, ring=0.07, bright=1.0, d=0.2), 0.004, 0.6)
    place(x, click(0.7, f=2900), 0.045, 0.6)
    return room(x, mix=0.1)


def faceplate_open() -> np.ndarray:
    """Hinge servo swings the mask up over the brow and stops softly."""
    d = 0.9
    x = motor(d, 240, 360, harm=12, gear=9, rough=0.06, curve='lin') * env_ar(d, 0.06, 0.18)
    place(x, armor_hit(420, weight=0.4, ring=0.1, bright=0.6, d=0.25), d - 0.06, 0.4)
    return room(x, mix=0.12)


def doff_vent() -> np.ndarray:
    """Seal release: a dry pneumatic chuff straight down (short, no hiss tail)."""
    x = silence(0.35)
    place(x, jet(0.3, 350, 3800, decay=0.05, attack=0.002), 0.0, 0.9)
    t = tt(0.2)
    place(x, np.sin(2 * np.pi * 70 * t) * np.exp(-t / 0.04), 0.0, 0.6)
    return room(x, mix=0.06)


def lock_release() -> np.ndarray:
    """A part's locks let go: bolt retracts with a clunk."""
    x = silence(0.3)
    place(x, click(0.9, f=2700), 0.0, 0.7)
    place(x, armor_hit(330, weight=0.6, ring=0.08, bright=0.6, d=0.25), 0.006, 0.7)
    return room(x, mix=0.08)


def arm_rise() -> np.ndarray:
    """Arm unfolds and climbs out of the ring."""
    d = 1.3
    x = motor(d, 110, 230, harm=12, gear=8, rough=0.05, curve='lin') * env_ar(d, 0.15, 0.4)
    return room(x, mix=0.1)


def extract() -> np.ndarray:
    """Unclamp a part off the suit: gripper bites, part breaks free of its seat."""
    x = silence(0.55)
    place(x, armor_hit(640, weight=0.4, ring=0.05, bright=0.9, d=0.15), 0.0, 0.6)
    place(x, armor_hit(240, weight=0.8, ring=0.14, bright=0.5, d=0.45), 0.05, 0.8)
    place(x, motor(0.25, 300, 380, harm=10, gear=9, rough=0.05) * env_ar(0.25, 0.03, 0.1), 0.08, 0.25)
    return room(x, mix=0.1)


def set_down() -> np.ndarray:
    """Part set back down on its stand."""
    x = silence(0.4)
    place(x, armor_hit(200, weight=0.6, ring=0.1, bright=0.4, d=0.35), 0.0, 0.8)
    place(x, click(0.6, f=3000), 0.08, 0.35)
    return room(x, mix=0.1)


def boot_sink() -> np.ndarray:
    """Boots ride the lift down into the hatch; the lift plates shut over them."""
    d = 1.6
    x = motor(d, 130, 55, harm=10, gear=6, rough=0.06, lo=40, hi=2200) * env_ar(d, 0.1, 0.4)
    place(x, armor_hit(110, weight=1.0, ring=0.15, bright=0.4, d=0.4), 1.45, 0.6)
    return room(x, mix=0.12)


SOUNDS = {
    # Director mix
    'mk3-boot-lift.mp3': boot_lift,
    'mk3-clamshell.mp3': clamshell,
    'mk3-waist-seal.mp3': waist_seal,
    'mk3-torso-servo.mp3': torso_servo,
    'mk3-plate-seat.mp3': plate_seat,
    'mk3-chest-slam.mp3': chest_slam,
    'mk3-reactor.mp3': reactor,
    'mk3-pauldron.mp3': pauldron,
    'mk3-arm-servo-bed.mp3': arm_servo_bed,
    'mk3-arm-clamp.mp3': arm_clamp,
    'mk3-drill.mp3': drill,
    'mk3-helmet-seat.mp3': helmet_seat,
    'mk3-gauntlet.mp3': gauntlet,
    'mk3-faceplate.mp3': faceplate,
    'mk3-vent.mp3': vent,
    # Action layer
    'mk3-arm-move.mp3': arm_move,
    'mk3-grip.mp3': grip,
    'mk3-release.mp3': release,
    'mk3-stand-sink.mp3': stand_sink,
    'mk3-port-lid.mp3': port_lid,
    'mk3-arm-stow.mp3': arm_stow,
    'mk3-rivet.mp3': rivet,
    'mk3-sparks.mp3': sparks,
    # Doffing
    'mk3-power-down.mp3': power_down,
    'mk3-latch.mp3': latch,
    'mk3-faceplate-open.mp3': faceplate_open,
    'mk3-doff-vent.mp3': doff_vent,
    'mk3-lock-release.mp3': lock_release,
    'mk3-arm-rise.mp3': arm_rise,
    'mk3-extract.mp3': extract,
    'mk3-set-down.mp3': set_down,
    'mk3-boot-sink.mp3': boot_sink,
}

# Files whose transients are pinned: keep at least this long (clip crops)
MIN_LEN = {'mk3-boot-lift.mp3': 1.8, 'mk3-drill.mp3': 1.05, 'mk3-helmet-seat.mp3': 2.0, 'mk3-faceplate.mp3': 2.0}


def main() -> None:
    only = set(sys.argv[1:])
    for name, fn in SOUNDS.items():
        if only and name not in only:
            continue
        # No trimming for pinned clips' heads; finish only trims the tail
        dur = write(name, finish(fn()), MIN_LEN.get(name, 0))
        print(f'{name}: {dur:.3f}s')


if __name__ == '__main__':
    main()
