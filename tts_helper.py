import sys
import os
import re
import subprocess
import hashlib
import shutil
import wave
import time
from glob import glob
from gtts import gTTS
from gtts.lang import tts_langs
from gtts.tokenizer import pre_processors


SCRIPT_DIR = os.path.dirname(__file__)
CACHE_DIR = os.path.join(SCRIPT_DIR, "tts-cache")
BIN_CACHE = {}
CACHE_MAX_BYTES = 1_000_000
MIN_CACHE_BYTES = 128
MAX_CACHE_SECONDS = 5.0
MAX_TEXT_LEN = 2000
VOLUME_BASE = 1.2
VOLUME_ALL_CAPS = 1.6
CACHE_STRIP_PREFIX = re.compile(r"^[^:]{1,40}\s+(says|sent|forwarded|replied to)\s+", re.IGNORECASE)
SAYS_PREFIX_REGEX = re.compile(r"^(.{1,80}?\s+says)\s+(.*)$", re.IGNORECASE)
URL_REGEX = re.compile(r"https?://\S+", re.IGNORECASE)
TENOR_REGEX = re.compile(r"https?://tenor\.com/\S+", re.IGNORECASE)
FFMPEG_AUDIO_ARGS = ["-ac", "1", "-ar", "46000", "-codec:a", "pcm_s16le"]

_WORD_REPLACEMENTS = {
  "by the way": ["btw"],
  "nevermind": ["nvm"],
  "i don't know": ["idk"],
  "in my opinion": ["imo"],
  "just kidding": ["jk"],
  "oh my god": ["omg"],
  "be right back": ["brb"],
  "shaking my head": ["smh"],
  "to be honest": ["tbh"],
  "people": ["ppl"],
  "as far as i know": ["afaik"],
  "i guess": ["ig"],
  "for real": ["fr"],
  "for real for real": ["frfr"],
  "good night": ["gn"],
  "good morning": ["gm"],
  "what are you doing": ["wyd"],
  "i don't care": ["idc"],
  "probably": ["prolly", "prob"],
  "different": ["diff", "dif"],
  "about": ["abt"],
  "because": ["cuz", "bc"],
  "thank you": ["thx", "ty", "tyty"],
  "see you": ["cya"],
  "real quick": ["rq"],
  "already": ["alr"],
  "i know": ["ik"],
  "message": ["msg"],
  "right now": ["rn"],
  "tomorrow": ["tmrw"],
  "please": ["pls"],
  "u w f": ["uwf"],
  "skyblock": ["hsb", "sb"],
  "what the fuck": ["wtf"],
  "you know": ["yk"],
  "cant be asked": ["cba"],
  "for what it's worth": ["fwiw"],
  "i swear to god": ["istg"],
  "fuck you mean": ["fym"],
  "i dont think so": ["idts"],
  "on god": ["ong"],
  "character": ["char"],
  "this shit": ["ts"],
  "actually": ["acc"],
  "no problem": ["np"],
  "earm": ["erm"],
  "o p": ["op"],
  "silksong": ["ss"],
  "foon": ["fo0n_"],
  "giff": ["gif"],
  "the fuck": ["tf"],
  "furious": ["furiouslyfast42"],
  "good job": ["gj"],
  "what do you mean": ["wdym"],
  "meow": [":3"],
  "heart": ["<3"],
  "i love you": ["ily"],
  "i know right": ["ikr"],
  "hollow knight": ["hk"],
  "of course": ["ofc"],
  "especially": ["esp"],
  "something": ["smth"],
  "motherfucker": ["mf"],
  "muhn": ["muunlul", "muun"],
  "let me know": ["lmk"],
  "alright": ["ight", "aight"],
  "at this point": ["atp"],
  "dot dot dot": ["..."],
  "king": ["k1ngdestruction"],
  "shut the fuck up": ["stfu"],
  "dont worry": ["dw"],
  "sorry": ["sry", "srry"],
  "big sad": ["D:"],
  "big happy": [":D"],
  "carrot": ["kuudraloremaster"],
  "background": ["bg"],
  "not gonna lie": ["ngl"],
  "to be fair": ["tbf"],
  "MC": ["mcisverygood"],
  "average": ["avg"],
  "grindey": ["grindy"],
  "broken heart": ["</3"],
  "he's": ["hes"],
  "I'd": ["id"],
  "40 lines": ["40l"],
  "tetraleague": ["tl"],
  "quickplay": ["qp"],
  "on my way": ["omw"],
  "shuur": ["sureeeeeeee", "suuuuuuure"],
  "good luck": ["gl"],
  "well played": ["wp"],
  "opus": ["Op."],
  "movement": ["mvnt", "mvt"],
  "almost blushing face": [">///<"],
  "my bad": ["mb"],
  "rune": ["rune_magic"],
  "really": ["rlly", "rly"],
  "i dont think": ["idt"],
  "mecfi": ["mcfe"],
  "all that": ["allat"],
  "fuh": ["pho"],
  "puise": ["pwease"],
  "shrug": ["¯\\_(ツ)_/¯"],
  "obviously": ["obv"],
  "eyoh3": ["ao3"],
  "fick": ["fic"],
  "dont worry dont worry": ["dwdw"],
  "too much information": ["tmi"],
  "I'm": ["im"],
  "youtube": ["yt"],
  "discord": ["dc"],
  "minecraft": ["mc"],
  "aydee h dee": ["adhd"],
  "voice training": ["vt"],
  "cute sad": [":c"],
  "for some reason": ["fsr"],
  "eu": ["ew"],
  "g geez": ["ggs"],
  "welcome back": ["wb"],
  "ziggy": ["notzigbay"],
  "jay fee": ["jayfe"],
  "c talon": ["ctalon"],
  "face tank": ["facetank"],
  "d i y": ["diy"],
  "matshure": ["mature"],
  "o slash": ["o/"],
  "pretty much": ["p much"],
  "you know what i mean": ["ykwim"],
  "i dont fucking know": ["idfk"],
  "np sees": ["npcs"],
  "i dont remember": ["idr"],
  "time save": ["timesave"],
  "weslay": ["weslay."],
  "masterful": ["mastrful.", "mastrful"],
  "shut your bitch ass up": ["sybau"],
  "dee ems": ["dms"],
  "boar vc": ["boarvc"],
  "helena": ["27helenal"],
  "homework": ["hw"],
  "breath of the wild": ["botw"],
  "have fun": ["hf"],
  "do you know": ["dyk"],
  "bitch": ["bitсh"],
  "immatshure": ["immature"],
  "smile": ["😄"],
  "project sekai": ["pjsk"],
  "jesus fucking christ": ["jfc"],
  "double's alt": ["cataclysm73"],
  "my face when": ["mfw"],
  "winter": ["winterthree5418."],
  "i'll": ["ill"],
  "won't": ["wont"],
  "haven't": ["havent"],
  "could've": ["couldve"],
  "would've": ["wouldve"],
  "should've": ["shouldve"],
  "shouldn't": ["shouldnt"],
  "duggy": ["superduggy117"],
  "of all time": ["oat"],
  "HP": ["hp"],
  "hot potato books": ["hpbs"],
  "enderman": ["eman", "emen"],
  "co opp": ["coop"],
  "recks": ["reqs"],
  "whatever": ["wtv"],
  "face tanking": ["facetanking"],
  "tisephony": ["tisiphone"],
  "rage quit": ["ragequit"],
  "glaysite": ["glacite"],
  "of them": ["of em"],
  "bouta": ["boutta"],
  " ": ["transit"],
  "theme-ing": ["themeing", "theming"],
  "low-key": ["lwk"],
  "you": ["oyu", "u"],
  "thank you so much": ["tysm"],
  "keyway": ["kiweh", "kiwehbird"],
  "super crazy rythm castle": ["scrc"],
  "yeah": ["ye", "ya", "yea"],
  "lahtsiji": ["laziji"],
  "level": ["lvl"],
  "face tanked": ["facetanked"],
  "j drag": ["jdrag"],
}

_WORD_PATTERNS = [
  (
    re.compile(r"(?i)(?<!\w)['\"]?(?:%s)['\"]?(?!\w)" % "|".join(re.escape(term) for term in terms)),
    replacement,
  )
  for replacement, terms in _WORD_REPLACEMENTS.items()
]

_SIMPLE_REPLACEMENTS_RAW = {
  r":\)": "smiley",
  r":\(": "frowney",
  r">\:\(": "angry smiley",
  r"emeraldcat99": "emerald",
  r"qwertyjayy": "jay",
  r"double2mc": "double",
  r"ichgehdiraufdenkeks": "keeks",
  r"\bkeks": "keeks",
  r"\.galaticat\.": "intro",
  r"invisfriend": "invis",
  r"megastab": "mega",
  r"boargalos": "boarguhlos",
  r"\bgalos\b": "guhlos",
  r"3/4ths": "three fourths",
  r"1/4th": "one fourth",
  r"1/2": "half",
  r"2/3rds": "two thirds",
  r"1/3rd": "one third",
  r"stop mindbeaming me": "stop coping jay",
  r"mindbeaming": "coping",
  r"boarpire": "boarpaier",
  r"0/10": "zero out of ten",
  r"1/10": "one out of ten",
  r"2/10": "two out of ten",
  r"3/10": "three out of ten",
  r"4/10": "four out of ten",
  r"5/10": "five out of ten",
  r"6/10": "six out of ten",
  r"7/10": "seven out of ten",
  r"8/10": "eight out of ten",
  r"9/10": "nine out of ten",
  r"10/10": "ten out of ten",
  r"boarnte": "boarnteh",
  r"👉 👈": "puise",
  r"\bsmp\b": "SMP",
  r"tetr\.io": "tetrio",
  r"1imb": "limb",
  r"😭": "sobbing face",
  r"67": "shut the fuck up",
  r"twt": "twitter",
  r"pogoduck": "pogo duck",
}

_SIMPLE_REPLACEMENTS = [
  (re.compile(pattern, re.IGNORECASE), replacement)
  for pattern, replacement in _SIMPLE_REPLACEMENTS_RAW.items()
]

CUSTOM_AUDIO_REGEX = [
  (re.compile(r"awooo+\*?", re.IGNORECASE), "clips/flea.wav"),
]

CUSTOM_AUDIO = {
  "yippie": "clips/yippie.mp3",
  "yippee": "clips/yippie.mp3",
  "garama": "clips/garama.wav",
}


def _match_custom_clip(text):
  for pattern, clip_path in CUSTOM_AUDIO_REGEX:
    m = pattern.search(text)
    if m and clip_path:
      return ("awooo", clip_path, m)
  lower_text = text.lower()
  for trig, clip_path in CUSTOM_AUDIO.items():
    if trig.lower() in lower_text:
      m = re.search(re.escape(trig), text, flags=re.IGNORECASE)
      if m:
        return (trig, clip_path, m)
  return (None, None, None)


def _find_binary(name):
  cached = BIN_CACHE.get(name)
  if cached and os.path.exists(cached):
    return cached
  # Check env first
  env_path = os.environ.get(name.upper() + "_PATH") or os.environ.get(name.upper() + "_BINARY")
  if env_path and os.path.exists(env_path):
    BIN_CACHE[name] = env_path
    return env_path
  roots = [
    os.path.join(SCRIPT_DIR, "tts-cache"),
    os.path.join(SCRIPT_DIR, "node_modules", "ffmpeg-static"),
  ]
  for root in roots:
    pattern = os.path.join(root, "**", f"{name}.exe")
    matches = glob(pattern, recursive=True)
    if matches:
      BIN_CACHE[name] = matches[0]
      return matches[0]
  BIN_CACHE[name] = None
  return None


def _configure_ffmpeg():
  ffmpeg = _find_binary("ffmpeg")
  ffprobe = _find_binary("ffprobe")
  if ffmpeg:
    os.environ["FFMPEG_BINARY"] = ffmpeg
    os.environ["FFMPEG_PATH"] = ffmpeg
    os.environ["PATH"] = f"{os.path.dirname(ffmpeg)}{os.pathsep}{os.environ.get('PATH','')}"
  if ffprobe:
    os.environ["FFPROBE_BINARY"] = ffprobe
    os.environ["FFPROBE_PATH"] = ffprobe
    os.environ["PATH"] = f"{os.path.dirname(ffprobe)}{os.pathsep}{os.environ.get('PATH','')}"

def write_langs_list(path):
  try:
    langs = tts_langs()
    lines = [f"{code} | {name}" for code, name in sorted(langs.items())]
    if lines:
      with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
  except Exception:
    return

def write_abbreviations_list(path):
  try:
    abbr = getattr(pre_processors, "ABBREVIATIONS", {}) or {}
    if not abbr:
      return
    lines = [f"{k} | {v}" for k, v in sorted(abbr.items())]
    with open(path, "w", encoding="utf-8") as f:
      f.write("\n".join(lines))
  except Exception:
    return

def _ensure_cache_dir():
  os.makedirs(CACHE_DIR, exist_ok=True)
  return CACHE_DIR

def _cache_key(text, volume_boost):
  key_src = f"{text}::vb:{volume_boost}"
  return hashlib.md5(key_src.encode("utf-8")).hexdigest()

def _normalize_for_cache(text):
  base = re.sub(r"\s+", " ", text).strip().lower()
  if not base:
    return []
  # Keep only the full normalized text to avoid cross-speaker cache collisions
  return [base]

def _cache_paths_for_text(text, volume_boost):
  variants = [text, *_normalize_for_cache(text)]
  paths = []
  for variant in variants:
    cache_path = os.path.join(CACHE_DIR, f"{_cache_key(variant, volume_boost)}.wav")
    if cache_path not in paths:
      paths.append(cache_path)
  return paths

def _wav_duration_seconds(path):
  try:
    with wave.open(path, "rb") as wf:
      frames = wf.getnframes()
      rate = wf.getframerate()
      if rate > 0:
        return frames / float(rate)
  except Exception:
    return None
  return None

def _valid_cache_file(path):
  try:
    stat = os.stat(path)
    if not (stat.st_size > MIN_CACHE_BYTES and stat.st_size <= CACHE_MAX_BYTES):
      return False
    dur = _wav_duration_seconds(path)
    if dur is None or dur > MAX_CACHE_SECONDS:
      return False
    return True
  except OSError:
    return False

def _write_cache_links(source, cache_paths):
  for cache_path in cache_paths:
    if os.path.exists(cache_path):
      continue
    try:
      os.link(source, cache_path)
    except Exception:
      try:
        shutil.copyfile(source, cache_path)
      except Exception:
        continue

def _volume_boost_for(text):
  letters = re.findall(r"[A-Za-z]", text)
  if letters and all(ch.isupper() for ch in letters):
    return max(VOLUME_BASE, VOLUME_ALL_CAPS)
  return VOLUME_BASE

def _fast_cache_copy(cache_paths, output):
  for cache_path in cache_paths:
    if not _valid_cache_file(cache_path):
      continue
    try:
      shutil.copyfile(cache_path, output)
      print(output)
      return True
    except Exception:
      continue
  return False

def _synthesize_with_cache(text, output, volume_boost):
  cache_paths = _cache_paths_for_text(text, volume_boost)
  if _fast_cache_copy(cache_paths, output):
    return True
  ffmpeg = _find_binary("ffmpeg")
  if not ffmpeg:
    raise RuntimeError("ffmpeg not found for gtts conversion")
  mp3_tmp = f"{output}.tmp.mp3"
  tts = gTTS(text=text, lang="en", tld="co.nz", slow=False)
  tts.save(mp3_tmp)
  cmd = [ffmpeg, "-y", "-i", mp3_tmp, *FFMPEG_AUDIO_ARGS]
  if volume_boost != 1.0:
    cmd += ["-filter:a", f"volume={volume_boost}"]
  cmd.append(output)
  result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
  try:
    if os.path.exists(mp3_tmp):
      os.remove(mp3_tmp)
  except Exception:
    pass
  if result.returncode != 0:
    raise RuntimeError(f"ffmpeg convert failed: {result.stderr.decode(errors='ignore')[:200]}")
  if _valid_cache_file(output):
    _write_cache_links(output, cache_paths)
  return True

def _replace_words(text):
  for pattern, replacement in _WORD_PATTERNS:
    text = pattern.sub(replacement, text)
  return text

def _apply_simple_replacements(text):
  for pattern, repl in _SIMPLE_REPLACEMENTS:
    text = pattern.sub(repl, text)
  return text


def main():
  if len(sys.argv) < 3:
    print("usage: tts_helper.py <text> <output_wav>", file=sys.stderr)
    sys.exit(1)
  text = sys.argv[1]
  voices_path = os.path.join(os.path.dirname(__file__), "voices.txt")
  if not os.path.exists(voices_path):  # avoid extra startup cost on every call
    write_langs_list(voices_path)
  abbr_path = os.path.join(os.path.dirname(__file__), "abbreviations.txt")
  if not os.path.exists(abbr_path):
    write_abbreviations_list(abbr_path)
  if len(text) > MAX_TEXT_LEN:
    print("text too long, skipping", file=sys.stderr)
    sys.exit(1)
  says_prefix = None
  body_text = text
  link_event = False
  prefix_match = SAYS_PREFIX_REGEX.match(text)
  if prefix_match:
    says_prefix = prefix_match.group(1).strip()
    body_text = prefix_match.group(2).strip()
  if TENOR_REGEX.search(body_text):
    body_text = "sent a gif"
    link_event = True
  elif URL_REGEX.search(body_text):
    body_text = "sent a link"
    link_event = True
  else:
    body_text = URL_REGEX.sub("", body_text).strip()
  if says_prefix and body_text:
    if link_event:
      speaker = re.sub(r"\s+says\s*$", "", says_prefix, flags=re.IGNORECASE).strip()
      text = f"{speaker} {body_text}".strip()
    else:
      text = f"{says_prefix} {body_text}"
  else:
    text = body_text or says_prefix or text
  text = re.sub(r"<a?:([A-Za-z0-9_]+):\d+>", r"\1", text)
  text = _apply_simple_replacements(text)
  text = _replace_words(text)
  output = sys.argv[2]
  os.makedirs(os.path.dirname(output), exist_ok=True)
  _configure_ffmpeg()
  _ensure_cache_dir()
  volume_boost = _volume_boost_for(text)
  lower_text = text.lower().strip()
  custom_trigger, custom_clip_path, custom_match = _match_custom_clip(text)
  # Skip cache hits for custom clip triggers so overrides always play.
  cache_paths = _cache_paths_for_text(text, volume_boost)
  bypass_cache = (
    bool(custom_trigger) or
    "double clip" in lower_text or
    "with ding" in lower_text
  )
  if not bypass_cache and _fast_cache_copy(cache_paths, output):
    return
  # If a custom clip appears inside the text, splice TTS segments with the clip audio in the middle.
  if custom_clip_path and custom_match and os.path.exists(custom_clip_path):
    ffmpeg = _find_binary("ffmpeg")
    if ffmpeg:
      prefix = text[:custom_match.start()].rstrip()
      suffix = text[custom_match.end():].lstrip()
      parts = []
      tmp_paths = []
      try:
        if prefix:
          pref_path = os.path.join(CACHE_DIR, f"pref-{os.getpid()}-{int(time.time()*1000)}.wav")
          _synthesize_with_cache(prefix, pref_path, volume_boost)
          parts.append(pref_path)
          tmp_paths.append(pref_path)
        parts.append(custom_clip_path)
        if suffix:
          suf_path = os.path.join(CACHE_DIR, f"suf-{os.getpid()}-{int(time.time()*1000)}.wav")
          _synthesize_with_cache(suffix, suf_path, volume_boost)
          parts.append(suf_path)
          tmp_paths.append(suf_path)
        inputs = []
        concat_inputs = []
        for idx, part in enumerate(parts):
          inputs.extend(["-i", part])
          concat_inputs.append(f"[{idx}:0]")
        concat_expr = "".join(concat_inputs) + f"concat=n={len(parts)}:v=0:a=1[out]"
        subprocess.run(
          [ffmpeg, "-y", *inputs, "-filter_complex", concat_expr, "-map", "[out]", *FFMPEG_AUDIO_ARGS, output],
          stdout=subprocess.PIPE,
          stderr=subprocess.PIPE,
          check=False,
        )
        if _valid_cache_file(output):
          _write_cache_links(output, cache_paths)
        print(output)
        return
      finally:
        for tmp in tmp_paths:
          try:
            os.remove(tmp)
          except Exception:
            pass
  # Custom audio overrides (examples) should run before cache hits so they always win.
  clip_trigger = custom_trigger
  clip_path = custom_clip_path
  if clip_trigger and clip_path and os.path.exists(clip_path):
    ffmpeg = _find_binary("ffmpeg")
    # If the text includes a "X says ..." prefix, speak the prefix then play the clip.
    prefix_audio = None
    split_match = SAYS_PREFIX_REGEX.match(text)
    if split_match:
      prefix_text = split_match.group(1).strip()
      if prefix_text:
        prefix_audio = os.path.join(CACHE_DIR, f"pref-{os.getpid()}-{int(time.time()*1000)}.wav")
        try:
          _synthesize_with_cache(prefix_text, prefix_audio, volume_boost)
        except Exception:
          prefix_audio = None
    try:
      if prefix_audio and ffmpeg:
        subprocess.run(
          [ffmpeg, "-y", "-i", prefix_audio, "-i", clip_path, "-filter_complex", "[0:0][1:0]concat=n=2:v=0:a=1[out]", "-map", "[out]", *FFMPEG_AUDIO_ARGS, output],
          stdout=subprocess.PIPE,
          stderr=subprocess.PIPE,
          check=False,
        )
      elif ffmpeg:
        subprocess.run(
          [ffmpeg, "-y", "-i", clip_path, *FFMPEG_AUDIO_ARGS, output],
          stdout=subprocess.PIPE,
          stderr=subprocess.PIPE,
          check=False,
        )
      else:
        shutil.copyfile(clip_path, output)
      if _valid_cache_file(output):
        _write_cache_links(output, cache_paths)
      print(output)
      return
    finally:
      if prefix_audio:
        try:
          os.remove(prefix_audio)
        except Exception:
          pass
  if "double clip" in lower_text:
    ffmpeg = _find_binary("ffmpeg")
    if ffmpeg and os.path.exists("clips/a.wav") and os.path.exists("clips/b.wav"):
      subprocess.run(
        [
          ffmpeg,
          "-y",
          "-i",
          "clips/a.wav",
          "-i",
          "clips/b.wav",
          "-filter_complex",
          "[0:0][1:0]concat=n=2:v=0:a=1[out]",
          "-map",
          "[out]",
          *FFMPEG_AUDIO_ARGS,
          output,
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
      )
      if _valid_cache_file(output):
        _write_cache_links(output, _cache_paths_for_text(text, volume_boost))
      print(output)
      return
  if "with ding" in lower_text:
    ffmpeg = _find_binary("ffmpeg")
    tts_path = f"{output}.tts.wav"
    # continue to normal TTS flow, then post-append ding below if we generated tts_path
  # Split speaker prefix "X says ..." to cache parts separately
  split_match = SAYS_PREFIX_REGEX.match(text)
  if split_match:
    prefix_text = split_match.group(1).strip()
    body_text = split_match.group(2).strip()
    if prefix_text and body_text:
      prefix_tmp = os.path.join(CACHE_DIR, f"pref-{os.getpid()}-{int(time.time()*1000)}.wav")
      body_tmp = os.path.join(CACHE_DIR, f"body-{os.getpid()}-{int(time.time()*1000)}.wav")
      try:
        _synthesize_with_cache(prefix_text, prefix_tmp, volume_boost)
        _synthesize_with_cache(body_text, body_tmp, volume_boost)
        ffmpeg = _find_binary("ffmpeg")
        if not ffmpeg:
          raise RuntimeError("ffmpeg not found for concat")
        subprocess.run(
          [
            ffmpeg,
            "-y",
            "-i",
            prefix_tmp,
            "-i",
            body_tmp,
            "-filter_complex",
            "[0:0][1:0]concat=n=2:v=0:a=1[out]",
            "-map",
            "[out]",
            *FFMPEG_AUDIO_ARGS,
            output,
          ],
          stdout=subprocess.PIPE,
          stderr=subprocess.PIPE,
          check=True,
        )
        print(output)
        return
      except Exception as exc:  # noqa: BLE001
        print(f"concat tts failed: {exc}", file=sys.stderr)
      finally:
        for tmp in (prefix_tmp, body_tmp):
          try:
            if os.path.exists(tmp):
              os.remove(tmp)
          except Exception:
            pass
  if not bypass_cache:
    cache_paths = _cache_paths_for_text(text, volume_boost)
    if _fast_cache_copy(cache_paths, output):
      return
  try:
    _synthesize_with_cache(text, output, volume_boost)
  except Exception as exc:  # noqa: BLE001
    print(f"tts_helper failed: {exc}", file=sys.stderr)
    sys.exit(1)
  if not os.path.exists(output) or os.path.getsize(output) == 0:
    print("tts_helper produced empty audio", file=sys.stderr)
    sys.exit(1)
  print(output)


if __name__ == "__main__":
  main()
  main()
