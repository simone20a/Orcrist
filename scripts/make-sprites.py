#!/usr/bin/env python3
"""
Generatore dello sprite del nano.

Disegnare pixel art contando i caratteri a mano e' un modo sicuro per
sbagliare: qui la si costruisce con primitive (rect, px, line), si
verifica guardando un PNG ingrandito, e solo alla fine si emettono le
righe da incollare in sprites.ts.

    python3 scripts/make-sprites.py --png /tmp/nano.png    anteprima
    python3 scripts/make-sprites.py --ts                   sorgente TS
"""

import argparse

W, H = 30, 34

# --- tavolozza --------------------------------------------------------
# Le lettere finiscono tali e quali nel sorgente TS: vanno scelte perche'
# si distinguano leggendo la griglia, non perche' siano brevi.
PALETTE = {
    'K': '#15110e',  # contorno
    'd': '#4d5560',  # elmo, ombra
    'h': '#79838f',  # elmo
    'H': '#a6b0bc',  # elmo, luce
    'g': '#c9a227',  # oro
    'G': '#8a6d18',  # oro, ombra
    's': '#d7a074',  # incarnato
    'S': '#ab7a50',  # incarnato, ombra
    'b': '#c8813f',  # barba
    'B': '#8c5526',  # barba, ombra
    't': '#4f6f5c',  # tunica
    'T': '#33483c',  # tunica, ombra
    'l': '#7a5334',  # cuoio
    'L': '#4a3220',  # cuoio, ombra
    'p': '#9c8256',  # zaino
    'P': '#6a5738',  # zaino, ombra
    'm': '#aab6c4',  # metallo
    'M': '#6c7784',  # metallo, ombra
    'r': '#96473a',  # coperta arrotolata
    'n': '#6d5540',  # brache
    'N': '#453424',  # brache, ombra
}

EMPTY = '.'


class Grid:
    def __init__(self):
        self.g = [[EMPTY] * W for _ in range(H)]

    def px(self, x, y, c):
        if 0 <= x < W and 0 <= y < H:
            self.g[y][x] = c

    def rect(self, x0, y0, x1, y1, c):
        for y in range(y0, y1 + 1):
            for x in range(x0, x1 + 1):
                self.px(x, y, c)

    def row(self, y, x0, x1, c):
        self.rect(x0, y, x1, y, c)

    def line(self, x0, y0, x1, y1, c):
        """Bresenham, per lo spallaccio e il fodero in diagonale."""
        dx, dy = abs(x1 - x0), abs(y1 - y0)
        sx = 1 if x0 < x1 else -1
        sy = 1 if y0 < y1 else -1
        err = dx - dy
        while True:
            self.px(x0, y0, c)
            if x0 == x1 and y0 == y1:
                break
            e2 = 2 * err
            if e2 > -dy:
                err -= dy
                x0 += sx
            if e2 < dx:
                err += dx
                y0 += sy

    def outline(self, c='K'):
        """Contorno sui pixel vuoti adiacenti a un pixel pieno."""
        out = [r[:] for r in self.g]
        for y in range(H):
            for x in range(W):
                if self.g[y][x] != EMPTY:
                    continue
                near = False
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nx, ny = x + dx, y + dy
                    if 0 <= nx < W and 0 <= ny < H and self.g[ny][nx] not in (EMPTY, c):
                        near = True
                        break
                if near:
                    out[y][x] = c
        self.g = out

    def rows(self):
        return [''.join(r) for r in self.g]


def body(g: Grid, bob: int, arm: int):
    """
    Tutto cio' che non sono le gambe.

    Budget verticale, ottenuto a forza di guardare il PNG: elmo 0-6,
    viso 7-11, barba 11-19, busto 13-24, cintura 23-24. Sotto restano
    otto righe per le gambe. Nelle versioni precedenti la testa scendeva
    fino alla 12 e gli stivali finivano fuori dal riquadro.
    """
    o = bob

    # --- zaino, dietro le spalle (guarda a destra) ----------------------
    g.rect(4, 12, 10, 22, 'p')
    g.rect(4, 12, 5, 22, 'P')                  # lato in ombra
    g.row(17, 4, 10, 'P')                      # cinghia orizzontale
    g.rect(3, 15, 3, 20, 'P')                  # tasca laterale
    g.rect(3, 9, 11, 11, 'r')                  # coperta arrotolata
    g.px(5, 10, 'L')
    g.px(9, 10, 'L')

    # --- spada, appesa dietro all'anca ------------------------------------
    # Il fodero scende ripido: quando era quasi orizzontale sembrava un
    # bastone portato a spalla, non un'arma alla cintura.
    g.line(9, 24, 5, 31, 'M')
    g.line(10, 24, 6, 31, 'M')
    g.line(11, 24, 7, 31, 'M')
    g.line(11, 25, 7, 32, 'L')
    g.line(10, 25, 6, 32, 'L')
    g.rect(5, 30, 7, 32, 'g')                  # puntale
    g.rect(9, 19, 10, 23, 'l')                 # impugnatura
    g.rect(8, 21, 11, 21, 'g')                 # guardia, stretta
    g.rect(9, 18, 10, 18, 'g')                 # pomo

    # --- elmo ---------------------------------------------------------------
    g.row(0 + o, 16, 18, 'H')
    g.row(1 + o, 15, 19, 'H')
    g.rect(14, 2 + o, 20, 3 + o, 'h')
    g.row(2 + o, 15, 18, 'H')
    g.rect(13, 4 + o, 21, 5 + o, 'h')
    g.rect(13, 4 + o, 14, 5 + o, 'd')
    g.rect(12, 6 + o, 22, 6 + o, 'g')          # fascia d'oro
    g.rect(12, 7 + o, 22, 7 + o, 'G')
    g.rect(20, 8 + o, 21, 11 + o, 'h')         # nasale
    g.rect(12, 8 + o, 13, 10 + o, 'd')         # paraorecchie

    # --- viso -----------------------------------------------------------------
    g.rect(14, 8 + o, 19, 10 + o, 's')
    g.px(18, 9 + o, 'K')                       # occhio
    g.px(17, 8 + o, 'S')                       # sopracciglio
    g.rect(19, 10 + o, 20, 11 + o, 's')
    g.rect(20, 12 + o, 21, 13 + o, 's')        # naso
    g.px(21, 14 + o, 'S')

    # --- tunica e cintura --------------------------------------------------------
    g.rect(11, 14 + o, 21, 24, 't')
    g.rect(11, 14 + o, 12, 24, 'T')
    g.line(12, 14 + o, 19, 20 + o, 'L')        # spallaccio
    g.line(12, 15 + o, 19, 21 + o, 'l')
    g.rect(10, 23, 21, 24, 'l')                # cintura
    g.rect(10, 23, 21, 23, 'L')
    g.rect(17, 23, 18, 24, 'g')                # fibbia

    # --- barba, davanti alla tunica ---------------------------------------------
    g.rect(13, 11 + o, 19, 13 + o, 'b')
    g.rect(12, 14 + o, 20, 17 + o, 'b')
    g.rect(13, 18 + o, 19, 19 + o, 'b')
    g.rect(15, 20 + o, 18, 20 + o, 'B')        # punta
    g.rect(12, 14 + o, 13, 19 + o, 'B')        # lato in ombra
    # ciocche: senza, la barba e' una macchia arancione compatta
    g.rect(15, 15 + o, 15, 19 + o, 'B')
    g.rect(18, 14 + o, 18, 18 + o, 'B')
    g.px(20, 15 + o, 'B')
    g.px(20, 17 + o, 'B')
    g.rect(18, 12 + o, 20, 12 + o, 'b')        # baffi

    # --- braccio in avanti, oscilla -------------------------------------------------
    ax = 20 + arm
    g.rect(ax, 16 + o, ax + 2, 22, 't')
    g.rect(ax + 2, 16 + o, ax + 2, 22, 'T')
    g.rect(ax, 23, ax + 2, 24, 's')            # mano


def legs(g: Grid, phase: int, bob: int):
    """
    Quattro fasi: contatto, affondo, passaggio, slancio.

    Le brache hanno un colore loro, distinto dalla tunica, e la gamba
    dietro e' piu' scura: due gambe verdi come il busto si fondevano in
    un blocco solo e il passo non si vedeva.
    """
    top = 25

    def leg(x, hip_drop, length, front):
        cloth, shade = ('n', 'N') if front else ('N', 'N')
        boot = 'l' if front else 'L'
        y0 = top + hip_drop
        g.rect(x, y0, x + 2, y0 + length, cloth)
        g.rect(x + 2, y0, x + 2, y0 + length, shade)
        g.rect(x, y0 + length + 1, x + 2, y0 + length + 2, boot)
        g.rect(x, y0 + length + 2, x + 3, y0 + length + 2, 'L')   # punta

    if phase == 0:      # contatto: massima apertura
        leg(10, 2, 1, False)
        leg(19, 2, 1, True)
    elif phase == 1:    # affondo: gambe raccolte, corpo basso
        leg(13, 1, 3, False)
        leg(17, 1, 3, True)
    elif phase == 2:    # passaggio: quella dietro si stacca da terra
        leg(14, 3, 1, False)
        leg(17, 0, 4, True)
    else:               # slancio: quella davanti si allunga in avanti
        leg(11, 2, 2, False)
        leg(20, 0, 4, True)



# =====================================================================
# Variante compatta
# =====================================================================
#
# Nella barra di stato lo sprite grande non ci sta: a scala 1 e' gia'
# uno a uno, quindi rimpicciolirlo non e' questione di scala ma di
# disegno. Questo e' lo stesso nano ridotto all'essenziale — elmo con
# fascia, barba, zaino, cintura, gambe — perche' a venti pixel i
# dettagli si impastano invece di leggersi.

MW, MH = 20, 22


class MiniGrid(Grid):
    def __init__(self):
        self.g = [[EMPTY] * MW for _ in range(MH)]

    def px(self, x, y, c):
        if 0 <= x < MW and 0 <= y < MH:
            self.g[y][x] = c

    def outline(self, c='K'):
        out = [r[:] for r in self.g]
        for y in range(MH):
            for x in range(MW):
                if self.g[y][x] != EMPTY:
                    continue
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nx, ny = x + dx, y + dy
                    if 0 <= nx < MW and 0 <= ny < MH and self.g[ny][nx] not in (EMPTY, c):
                        out[y][x] = c
                        break
        self.g = out


def mini_frame(phase: int):
    g = MiniGrid()
    o = (0, 1, 0, 1)[phase]
    arm = (1, 0, -1, 0)[phase]

    # zaino e coperta
    g.rect(2, 7, 6, 14, 'p')
    g.rect(2, 7, 3, 14, 'P')
    g.rect(2, 5, 7, 6, 'r')

    # spada
    g.line(6, 15, 3, 20, 'M')
    g.line(7, 15, 4, 20, 'M')
    g.rect(6, 12, 7, 14, 'l')
    g.rect(6, 11, 7, 11, 'g')

    # busto e cintura, prima della barba: nella prima versione erano
    # dopo, e il rettangolo della tunica cancellava mezza barba
    g.rect(8, 8 + o, 14, 15, 't')
    g.rect(8, 8 + o, 9, 15, 'T')
    ax = 14 + arm
    g.rect(ax, 10 + o, ax + 1, 14, 't')
    g.rect(7, 14, 14, 15, 'l')
    g.rect(12, 14, 13, 15, 'g')

    # elmo: calotta stretta e alta, la fascia larga quanto la testa —
    # piu' larga sembrava la tesa di un cappello
    g.rect(10, 0 + o, 13, 0 + o, 'H')
    g.rect(9, 1 + o, 14, 2 + o, 'H')
    g.rect(9, 2 + o, 14, 2 + o, 'h')
    g.rect(9, 3 + o, 14, 3 + o, 'g')
    g.rect(13, 4 + o, 14, 6 + o, 'h')      # nasale

    # viso
    g.rect(10, 4 + o, 13, 5 + o, 's')
    g.px(12, 4 + o, 'K')
    g.rect(13, 6 + o, 14, 7 + o, 's')      # naso

    # barba, sopra la tunica
    g.rect(9, 6 + o, 13, 11 + o, 'b')
    g.rect(9, 6 + o, 9, 11 + o, 'B')
    g.rect(11, 7 + o, 11, 11 + o, 'B')
    g.rect(10, 12 + o, 12, 12 + o, 'B')

    # gambe: la dietro scura e piu' corta, la davanti chiara
    back_x, back_len, front_x, front_len = (
        (7, 0, 13, 0), (9, 2, 12, 2), (9, 1, 12, 3), (8, 1, 14, 2))[phase]
    g.rect(back_x, 16, back_x + 1, 16 + back_len, 'N')
    g.rect(back_x, 17 + back_len, back_x + 2, 18 + back_len, 'L')
    g.rect(front_x, 16, front_x + 1, 16 + front_len, 'n')
    g.rect(front_x, 17 + front_len, front_x + 2, 18 + front_len, 'l')

    g.outline()
    return g



# =====================================================================
# Ritratto per l'icona
# =====================================================================
#
# Un primo piano, non il nano intero rimpicciolito: testa, barba e
# spalle in profilo, con la lama impugnata davanti al petto.
#
# La spada e' un'altra rispetto a quella del ciclo di camminata, dove
# pende al fianco: in un ritratto tagliato alle spalle un'arma alla
# cintura resterebbe fuori inquadratura. Qui e' sguainata e verticale,
# accanto al viso ma senza coprirlo — e' meta' del soggetto, visto che
# l'applicazione si chiama come una spada.

IW, IH = 28, 30


class IconGrid(Grid):
    def __init__(self):
        self.g = [[EMPTY] * IW for _ in range(IH)]

    def px(self, x, y, c):
        if 0 <= x < IW and 0 <= y < IH:
            self.g[y][x] = c

    def outline(self, c='K'):
        out = [r[:] for r in self.g]
        for y in range(IH):
            for x in range(IW):
                if self.g[y][x] != EMPTY:
                    continue
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nx, ny = x + dx, y + dy
                    if 0 <= nx < IW and 0 <= ny < IH and self.g[ny][nx] not in (EMPTY, c):
                        out[y][x] = c
                        break
        self.g = out


def icon_frame():
    """
    Mezzobusto di profilo, rivolto a destra, con la lama sguainata
    accanto al viso.

    Il profilo si costruisce riga per riga, non a rettangoli: la
    sagoma deve sporgere progressivamente — fronte, arcata, punta del
    naso — e poi rientrare sotto i baffi. Disegnandolo come un
    rettangolo con il naso attaccato di fianco, il naso restava un
    blocco staccato che sembrava un becco.

    Budget verticale: riga 0 libera per il contorno, elmo 1-7, viso
    8-13, barba 11-24, spalle 25-29.
    """
    g = IconGrid()

    # --- spalle e mantello, sul fondo ---------------------------------
    g.rect(1, 25, 21, 29, 't')
    g.rect(1, 25, 4, 29, 'T')
    g.rect(2, 27, 20, 27, 'T')        # cucitura
    # Spallaccio che segue la linea della spalla invece di essere un
    # blocco appoggiato di lato.
    g.rect(2, 24, 9, 25, 'l')
    g.rect(1, 26, 8, 27, 'l')
    g.rect(1, 26, 3, 27, 'L')
    g.rect(2, 24, 3, 25, 'L')

    # --- elmo -----------------------------------------------------------
    g.rect(9, 1, 15, 1, 'H')
    g.rect(8, 2, 16, 2, 'H')
    g.rect(7, 3, 17, 5, 'h')
    g.rect(9, 3, 13, 4, 'H')          # riflesso sulla calotta
    g.rect(6, 5, 18, 5, 'h')
    g.rect(6, 5, 8, 5, 'd')
    g.rect(5, 6, 19, 6, 'g')          # fascia d'oro
    g.rect(5, 7, 19, 7, 'G')
    g.rect(5, 8, 7, 12, 'd')          # paraorecchie

    # --- viso: la sagoma sporge riga dopo riga ---------------------------
    g.row(8, 8, 15, 's')
    g.row(9, 8, 16, 's')
    g.row(10, 8, 17, 's')
    g.row(11, 8, 18, 's')
    g.row(12, 9, 19, 's')             # punta del naso
    g.row(13, 10, 18, 's')            # rientro sotto il naso
    g.rect(8, 8, 9, 13, 'S')          # tempia in ombra
    g.rect(14, 9, 16, 9, 'S')         # arcata sopracciliare
    g.px(15, 10, 'K')                 # occhio: un pixel, non un buco
    g.rect(17, 13, 18, 13, 'S')       # narice

    # Niente nasale: a questa scala il paranaso cadeva proprio sopra la
    # punta del naso e la spezzava in due, lasciando un pixel di pelle
    # isolato oltre il metallo. L'elmo si riconosce comunque dalla
    # calotta e dalla fascia d'oro.

    # --- barba: silhouette arrotondata, non un rettangolo -----------------
    g.rect(5, 11, 9, 13, 'b')         # basette, dietro allo zigomo
    g.row(14, 5, 18, 'b')             # baffi, sotto il naso
    g.rect(5, 15, 17, 18, 'b')
    g.rect(6, 19, 16, 21, 'b')
    g.rect(7, 22, 14, 23, 'b')
    g.rect(9, 24, 12, 24, 'B')        # punta
    g.rect(5, 11, 7, 23, 'B')         # lato in ombra
    # tre ciocche: senza, la barba resta una macchia compatta
    g.rect(9, 16, 9, 23, 'B')
    g.rect(12, 15, 12, 23, 'B')
    # Niente pixel sparsi sul bordo destro: staccati dal resto
    # sembravano briciole, non ombre.

    # --- spada sguainata, accanto al viso -------------------------------------
    # Verticale e lunga quanto tutto il ritratto: e' meta' del soggetto,
    # visto che l'applicazione porta il nome di una spada.
    g.rect(21, 0, 23, 17, 'm')        # lama
    g.rect(23, 0, 23, 17, 'M')        # filo in ombra
    g.rect(22, 1, 22, 16, 'H')        # sguscio, la luce
    g.rect(20, 18, 25, 18, 'g')       # guardia
    g.rect(20, 19, 25, 19, 'G')
    g.rect(21, 20, 23, 25, 'l')       # impugnatura
    g.rect(23, 20, 23, 25, 'L')
    g.rect(20, 26, 24, 27, 'g')       # pomo
    g.rect(20, 27, 24, 27, 'G')

    g.outline()
    return g


def frame(phase: int):
    bob = (0, 1, 0, 1)[phase]
    arm = (1, 0, -1, 0)[phase]
    g = Grid()
    body(g, bob, arm)
    legs(g, phase, bob)
    g.outline()
    return g


def to_png(frames, path, scale=8):
    from PIL import Image

    cols = max(len(f.rows()[0]) for f in frames)
    rows = max(len(f.rows()) for f in frames)
    img = Image.new('RGBA', (cols * len(frames) * scale, rows * scale), (14, 13, 12, 255))
    px = img.load()
    for i, g in enumerate(frames):
        for y, line in enumerate(g.rows()):
            for x, ch in enumerate(line):
                if ch == EMPTY:
                    continue
                hexv = PALETTE[ch].lstrip('#')
                rgb = tuple(int(hexv[k:k + 2], 16) for k in (0, 2, 4))
                bx = (i * cols + x) * scale
                by = y * scale
                for dy in range(scale):
                    for dx in range(scale):
                        px[bx + dx, by + dy] = rgb + (255,)
    img.save(path)
    print(f'scritto {path}  ({img.width}x{img.height})')


def to_ts(frames, name='DWARF_WALK'):
    print(f'export const {name}: string[][] = [')
    for g in frames:
        print('  [')
        for line in g.rows():
            print(f"    '{line}',")
        print('  ],')
    print('];')


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--png')
    ap.add_argument('--ts', action='store_true')
    a = ap.parse_args()

    frames = [frame(i) for i in range(4)]
    minis = [mini_frame(i) for i in range(4)]
    if a.png:
        to_png(frames, a.png)
        to_png(minis, a.png.replace('.png', '-mini.png'), scale=12)
        to_png([icon_frame()], a.png.replace('.png', '-ritratto.png'), scale=16)
    if a.ts:
        to_ts(frames)
        print()
        print('/** Variante compatta, per la barra di stato. */')
        to_ts(minis, 'DWARF_WALK_MINI')
