#!/usr/bin/env python3
"""
Icona dell'applicazione.

Il soggetto e' il ritratto di scripts/make-sprites.py: mezzobusto di
profilo con la lama sguainata. Non la figura intera che cammina — a
dimensione d'icona diventava un francobollo con la testa di sei pixel
e la spada, che nella camminata pende alla cintura, invisibile.

    python3 scripts/make-icon.py            genera build/icon.{png,ico,icns}
    python3 scripts/make-icon.py --preview /tmp/prova.png

Ogni taglia viene DISEGNATA, non ridimensionata. Rimpicciolire un
1024 con un filtro di ricampionamento impasta la pixel art: a 64 pixel
il nano diventava una macchia. Qui si sceglie per ogni taglia lo
sprite adatto e un fattore di scala intero, cosi' i pixel restano
pixel.

Il banco di prova e' l'anteprima: un'icona si giudica a trentadue
pixel, non a mille.
"""

import argparse
import importlib.util
import io
import pathlib
import struct

from PIL import Image, ImageDraw, ImageFilter

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('sprites', HERE / 'make-sprites.py')
sprites = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sprites)

BG_TOP = (28, 23, 18)
BG_BOTTOM = (13, 11, 9)
GOLD = (240, 177, 62)
EDGE = (92, 72, 38)
PATH = (66, 55, 41)


def hexc(h: str) -> tuple[int, int, int]:
    h = h.lstrip('#')
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def ink_bounds(rows: list[str]) -> tuple[int, int]:
    """Colonne davvero occupate: il nano non e' centrato nella griglia."""
    xs = [x for row in rows for x, ch in enumerate(row) if ch in sprites.PALETTE]
    return (min(xs), max(xs)) if xs else (0, len(rows[0]) - 1)


def choose_art(size: int) -> tuple[list[str], int]:
    """
    Righe di pixel e fattore di scala per una data dimensione.

    Sotto i 48 pixel nemmeno il ritratto ci sta per intero: si taglia
    alle spalle e restano testa, barba e lama, che sono le tre cose
    che a quella dimensione si distinguono ancora.
    """
    rows = sprites.icon_frame().rows()
    h = len(rows)
    if size >= 512:
        return rows, max(1, round(size * 0.60 / h))
    if size >= 128:
        return rows, max(1, round(size * 0.58 / h))
    if size >= 48:
        return rows, 1
    return rows[:26], 1


def build(size: int) -> Image.Image:
    # macOS lascia respirare le icone grandi; alle taglie minute il
    # margine mangia i pochi pixel disponibili, quindi si stringe.
    inset = 0.82 if size >= 128 else 0.93
    plaque = int(size * inset)
    radius = max(2, int(plaque * 0.225))
    off = (size - plaque) // 2

    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))

    # --- targa -----------------------------------------------------------
    grad = Image.new('RGBA', (plaque, plaque))
    gd = ImageDraw.Draw(grad)
    for y in range(plaque):
        k = y / max(1, plaque - 1)
        gd.line([(0, y), (plaque, y)],
                fill=tuple(int(a + (b - a) * k) for a, b in zip(BG_TOP, BG_BOTTOM)) + (255,))

    # bagliore di fornace in basso, la stessa luce della schermata d'apertura
    glow = Image.new('L', (plaque, plaque), 0)
    ImageDraw.Draw(glow).ellipse(
        [-plaque * 0.1, plaque * 0.52, plaque * 1.1, plaque * 1.35], fill=170
    )
    glow = glow.filter(ImageFilter.GaussianBlur(max(1, plaque * 0.10)))
    # Alle taglie minute il bagliore e' l'unica cosa che stacca la
    # sagoma dal fondo: si alza, perche' li' il dettaglio non aiuta.
    strength = 0.28 if size >= 128 else 0.44
    grad = Image.composite(Image.new('RGBA', grad.size, GOLD + (255,)), grad,
                           glow.point(lambda v: int(v * strength)))

    mask = Image.new('L', (plaque, plaque), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, plaque - 1, plaque - 1], radius, fill=255)

    if size >= 128:
        shadow = Image.new('RGBA', (size, size), (0, 0, 0, 0))
        ImageDraw.Draw(shadow).rounded_rectangle(
            [off, off + plaque // 24, off + plaque, off + plaque + plaque // 24],
            radius, fill=(0, 0, 0, 140))
        img.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(size * 0.016)))

    card = Image.new('RGBA', (plaque, plaque), (0, 0, 0, 0))
    card.paste(grad, (0, 0), mask)
    ImageDraw.Draw(card).rounded_rectangle(
        [0, 0, plaque - 1, plaque - 1], radius,
        outline=EDGE + (255,), width=max(1, plaque // 150))
    img.alpha_composite(card, (off, off))

    # --- ritratto -------------------------------------------------------------
    # Un mezzobusto si centra, non si appoggia a terra: la linea di
    # sentiero che c'era sotto la figura intera qui non ha senso.
    # Leggermente sopra la meta', perche' un volto centrato
    # matematicamente sembra sempre un po' caduto.
    rows, scale = choose_art(size)
    x0, x1 = ink_bounds(rows)
    ink_w = (x1 - x0 + 1) * scale
    art_h = len(rows) * scale

    left = size // 2 - ink_w // 2 - x0 * scale
    top = off + (plaque - art_h) // 2 - max(1, plaque // 40)

    d = ImageDraw.Draw(img)
    for y, line in enumerate(rows):
        for x, ch in enumerate(line):
            if ch not in sprites.PALETTE:
                continue
            px, py = left + x * scale, top + y * scale
            d.rectangle([px, py, px + scale - 1, py + scale - 1], fill=hexc(sprites.PALETTE[ch]))

    return img


def png_bytes(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, 'PNG')
    return buf.getvalue()


def write_icns(path: pathlib.Path, at) -> None:
    """
    Contenitore ICNS scritto a mano.

    Pillow legge gli .icns ma per scriverli si appoggia a `iconutil`,
    che esiste solo su macOS: qui la generazione deve funzionare
    ovunque, e il formato e' solo una sequenza di blocchi PNG con un
    codice di quattro lettere davanti.
    """
    entries = {
        'icp4': 16, 'icp5': 32, 'ic11': 32, 'ic12': 64,
        'ic07': 128, 'ic08': 256, 'ic13': 256, 'ic09': 512,
        'ic14': 512, 'ic10': 1024,
    }
    body = b''
    for code, size in entries.items():
        png = png_bytes(at(size))
        body += code.encode('ascii') + struct.pack('>I', len(png) + 8) + png
    path.write_bytes(b'icns' + struct.pack('>I', len(body) + 8) + body)


def preview(at, path: str) -> None:
    sizes = [512, 256, 128, 64, 32, 16]
    pad = 26
    width = sum(sizes) + pad * (len(sizes) + 1)
    canvas = Image.new('RGB', (width, 512 + pad * 2), (38, 38, 40))
    x = pad
    for s in sizes:
        icon = at(s)
        canvas.paste(icon, (x, pad + 512 - s), icon)
        x += s + pad
    canvas.save(path)
    print(f'anteprima: {path}')


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--preview')
    ap.add_argument('--out', default=str(HERE.parent / 'build'))
    a = ap.parse_args()

    cache: dict[int, Image.Image] = {}

    def at(size: int) -> Image.Image:
        if size not in cache:
            cache[size] = build(size)
        return cache[size]

    if a.preview:
        preview(at, a.preview)

    out = pathlib.Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    at(1024).save(out / 'icon.png')
    # L'ICO contiene le taglie disegnate una per una, non un unico
    # ridimensionamento.
    at(256).save(out / 'icon.ico',
                 sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
                 append_images=[at(s) for s in (128, 64, 48, 32, 24, 16)])
    write_icns(out / 'icon.icns', at)
    print(f'scritte {out}/icon.png, icon.ico, icon.icns')
