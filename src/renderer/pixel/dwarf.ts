// =====================================================================
// Il nano che cammina.
//
// GENERATO da scripts/make-sprites.py — non si modifica a mano: si
// cambia lo script, si guarda il PNG che produce, e si rigenera con
//
//     python3 scripts/make-sprites.py --ts > src/renderer/pixel/dwarf.ts
//
// Ogni riga e' una riga di pixel, ogni carattere un colore della
// tavolozza qui sotto; il punto e' trasparente.
//
// Due taglie perche' a scala 1 lo sprite e' gia' uno a uno: nella
// barra di stato non serve una scala minore, serve un disegno piu'
// piccolo.
// =====================================================================

export const DWARF_PALETTE: Record<string, string> = {
  K: '#15110e',       // contorno
  d: '#4d5560',       // elmo, ombra
  h: '#79838f',       // elmo
  H: '#a6b0bc',       // elmo, luce
  g: '#c9a227',       // oro
  G: '#8a6d18',       // oro, ombra
  s: '#d7a074',       // incarnato
  S: '#ab7a50',       // incarnato, ombra
  b: '#c8813f',       // barba
  B: '#8c5526',       // barba, ombra
  t: '#4f6f5c',       // tunica
  T: '#33483c',       // tunica, ombra
  l: '#7a5334',       // cuoio
  L: '#4a3220',       // cuoio, ombra
  p: '#9c8256',       // zaino
  P: '#6a5738',       // zaino, ombra
  m: '#aab6c4',       // metallo
  M: '#6c7784',       // metallo, ombra
  r: '#96473a',       // coperta arrotolata
  n: '#6d5540',       // brache
  N: '#453424',       // brache, ombra
};

export const DWARF_WIDTH = 30;
export const DWARF_HEIGHT = 34;
export const DWARF_MINI_WIDTH = 20;
export const DWARF_MINI_HEIGHT = 22;

/** Ciclo di camminata: contatto, affondo, passaggio, slancio. */
export const DWARF_WALK: string[][] = [
  [
    '...............KHHHK..........',
    '..............KHHHHHK.........',
    '.............KhHHHHhhK........',
    '.............KhhhhhhhK........',
    '............KddhhhhhhhK.......',
    '............KddhhhhhhhK.......',
    '...........KgggggggggggK......',
    '...........KGGGGGGGGGGGK......',
    '...KKKKKKKKKddsssSsshhK.......',
    '..KrrrrrrrrrddssssKshhK.......',
    '..KrrLrrrLrrddssssssshK.......',
    '..KrrrrrrrrrKbbbbbbbshK.......',
    '...KPPpppppKKbbbbbbbbsK.......',
    '...KPPpppppKKbbbbbbbssK.......',
    '...KPPpppppTBBbbbbBbbtK.......',
    '..KPPPpppppTBBbBbbBbBtKK......',
    '..KPPPpppppTBBbBbbBbbttTK.....',
    '..KPPPPPPPPTBBbBbbBbBttTK.....',
    '..KPPPpppggTBBbBbbBbtttTK.....',
    '..KPPPpppllTBBbBbbbbtttTK.....',
    '..KPPPpppllTTttBBBBLtttTK.....',
    '...KPPppgggTTttttttltttTK.....',
    '...KPPpppllTTttttttttttTK.....',
    '....KKKKKlLLLLLLLggLLsssK.....',
    '........KMlllllllggllsssK.....',
    '.......KMMLLKKKKKKKKKKKK......',
    '.......KMLLKK......KKK........',
    '......KMMLNNNK....KnnNK.......',
    '......KMLLNNNK....KnnNK.......',
    '.....KMMLLLLLK....KlllK.......',
    '....KgggLKLLLLK...KLLLLK......',
    '....KgggLKKKKK.....KKKK.......',
    '....KgggK.....................',
    '.....KKK......................',
  ],
  [
    '................KKK...........',
    '...............KHHHK..........',
    '..............KHHHHHK.........',
    '.............KhHHHHhhK........',
    '.............KhhhhhhhK........',
    '............KddhhhhhhhK.......',
    '............KddhhhhhhhK.......',
    '...........KgggggggggggK......',
    '...KKKKKKKKKGGGGGGGGGGGK......',
    '..KrrrrrrrrrddsssSsshhK.......',
    '..KrrLrrrLrrddssssKshhK.......',
    '..KrrrrrrrrrddssssssshK.......',
    '...KPPpppppKKbbbbbbbshK.......',
    '...KPPpppppKKbbbbbbbbsK.......',
    '...KPPpppppKKbbbbbbbssK.......',
    '..KPPPpppppTBBbbbbBbbtK.......',
    '..KPPPpppppTBBbBbbBbBtK.......',
    '..KPPPPPPPPTBBbBbbBbttTK......',
    '..KPPPpppggTBBbBbbBbttTK......',
    '..KPPPpppllTBBbBbbBbttTK......',
    '..KPPPpppllTBBbBbbbbttTK......',
    '...KPPppgggTTttBBBBLttTK......',
    '...KPPpppllTTttttttlttTK......',
    '....KKKKKlLLLLLLLggLsssK......',
    '........KMlllllllgglsssK......',
    '.......KMMLLKKKKKKKKKKK.......',
    '.......KMLLKKNNNKnnNK.........',
    '......KMMLLKKNNNKnnNK.........',
    '......KMLLK.KNNNKnnNK.........',
    '.....KMMLLK.KNNNKnnNK.........',
    '....KgggLK..KLLLKlllK.........',
    '....KgggLK..KLLLLLLLLK........',
    '....KgggK....KKKKKKKK.........',
    '.....KKK......................',
  ],
  [
    '...............KHHHK..........',
    '..............KHHHHHK.........',
    '.............KhHHHHhhK........',
    '.............KhhhhhhhK........',
    '............KddhhhhhhhK.......',
    '............KddhhhhhhhK.......',
    '...........KgggggggggggK......',
    '...........KGGGGGGGGGGGK......',
    '...KKKKKKKKKddsssSsshhK.......',
    '..KrrrrrrrrrddssssKshhK.......',
    '..KrrLrrrLrrddssssssshK.......',
    '..KrrrrrrrrrKbbbbbbbshK.......',
    '...KPPpppppKKbbbbbbbbsK.......',
    '...KPPpppppKKbbbbbbbssK.......',
    '...KPPpppppTBBbbbbBbbtK.......',
    '..KPPPpppppTBBbBbbBbBtK.......',
    '..KPPPpppppTBBbBbbBttTK.......',
    '..KPPPPPPPPTBBbBbbBttTK.......',
    '..KPPPpppggTBBbBbbBttTK.......',
    '..KPPPpppllTBBbBbbbttTK.......',
    '..KPPPpppllTTttBBBBttTK.......',
    '...KPPppgggTTttttttttTK.......',
    '...KPPpppllTTttttttttTK.......',
    '....KKKKKlLLLLLLLggsssK.......',
    '........KMlllllllggsssK.......',
    '.......KMMLLKKKKKnnNKK........',
    '.......KMLLK....KnnNK.........',
    '......KMMLLK..KKKnnNK.........',
    '......KMLLK..KNNNnnNK.........',
    '.....KMMLLK..KNNNnnNK.........',
    '....KgggLK...KLLLlllK.........',
    '....KgggLK...KLLLLLLLK........',
    '....KgggK.....KKKKKKK.........',
    '.....KKK......................',
  ],
  [
    '................KKK...........',
    '...............KHHHK..........',
    '..............KHHHHHK.........',
    '.............KhHHHHhhK........',
    '.............KhhhhhhhK........',
    '............KddhhhhhhhK.......',
    '............KddhhhhhhhK.......',
    '...........KgggggggggggK......',
    '...KKKKKKKKKGGGGGGGGGGGK......',
    '..KrrrrrrrrrddsssSsshhK.......',
    '..KrrLrrrLrrddssssKshhK.......',
    '..KrrrrrrrrrddssssssshK.......',
    '...KPPpppppKKbbbbbbbshK.......',
    '...KPPpppppKKbbbbbbbbsK.......',
    '...KPPpppppKKbbbbbbbssK.......',
    '..KPPPpppppTBBbbbbBbbtK.......',
    '..KPPPpppppTBBbBbbBbBtK.......',
    '..KPPPPPPPPTBBbBbbBbttTK......',
    '..KPPPpppggTBBbBbbBbttTK......',
    '..KPPPpppllTBBbBbbBbttTK......',
    '..KPPPpppllTBBbBbbbbttTK......',
    '...KPPppgggTTttBBBBLttTK......',
    '...KPPpppllTTttttttlttTK......',
    '....KKKKKlLLLLLLLggLsssK......',
    '........KMlllllllgglsssK......',
    '.......KMMLLKKKKKKKKnnNK......',
    '.......KMLLKKK.....KnnNK......',
    '......KMMLLNNNK....KnnNK......',
    '......KMLLKNNNK....KnnNK......',
    '.....KMMLLKNNNK....KnnNK......',
    '....KgggLKKLLLK....KlllK......',
    '....KgggLKKLLLLK...KLLLLK.....',
    '....KgggK..KKKK.....KKKK......',
    '.....KKK......................',
  ],
];

/** Variante compatta, per la barra di stato. */
export const DWARF_WALK_MINI: string[][] = [
  [
    '.........KHHHHK.....',
    '........KHHHHHHK....',
    '........KhhhhhhK....',
    '........KggggggK....',
    '..KKKKKK.KssKshK....',
    '.KrrrrrrKKsssshK....',
    '.KrrrrrrKBbbbbsK....',
    '.KPPpppKKBbBbbsK....',
    '.KPPpppKTBbBbbtK....',
    '.KPPpppKTBbBbbtKK...',
    '.KPPpppKTBbBbbtttK..',
    '.KPPppggTBbBbbtttK..',
    '.KPPppllTTBBBttttK..',
    '.KPPppllTTtttttttK..',
    '.KPPppllllllgglttK..',
    '..KKKKMlllllgglKK...',
    '....KMMNNKKKKnnK....',
    '....KMMLLLK.KlllK...',
    '...KMMKLLLK.KlllK...',
    '...KMMKKKK...KKK....',
    '..KMMK..............',
    '...KK...............',
  ],
  [
    '..........KKKK......',
    '.........KHHHHK.....',
    '........KHHHHHHK....',
    '........KhhhhhhK....',
    '..KKKKKKKggggggK....',
    '.KrrrrrrKKssKshK....',
    '.KrrrrrrKKsssshK....',
    '.KPPpppKKBbbbbsK....',
    '.KPPpppKKBbBbbsK....',
    '.KPPpppKTBbBbbtK....',
    '.KPPpppKTBbBbbtK....',
    '.KPPppggTBbBbbttK...',
    '.KPPppllTBbBbbttK...',
    '.KPPppllTTBBBtttK...',
    '.KPPppllllllggltK...',
    '..KKKKMlllllgglK....',
    '....KMMKKNNKnnK.....',
    '....KMMKKNNKnnK.....',
    '...KMMK.KNNKnnK.....',
    '...KMMK.KLLLlllK....',
    '..KMMK..KLLLlllK....',
    '...KK....KKKKKK.....',
  ],
  [
    '.........KHHHHK.....',
    '........KHHHHHHK....',
    '........KhhhhhhK....',
    '........KggggggK....',
    '..KKKKKK.KssKshK....',
    '.KrrrrrrKKsssshK....',
    '.KrrrrrrKBbbbbsK....',
    '.KPPpppKKBbBbbsK....',
    '.KPPpppKTBbBbbtK....',
    '.KPPpppKTBbBbbtK....',
    '.KPPpppKTBbBbbtK....',
    '.KPPppggTBbBbbtK....',
    '.KPPppllTTBBBttK....',
    '.KPPppllTTtttttK....',
    '.KPPppllllllgglK....',
    '..KKKKMlllllgglK....',
    '....KMMKKNNKnnK.....',
    '....KMMKKNNKnnK.....',
    '...KMMK.KLLLnnK.....',
    '...KMMK.KLLLnnK.....',
    '..KMMK...KKKlllK....',
    '...KK......KlllK....',
  ],
  [
    '..........KKKK......',
    '.........KHHHHK.....',
    '........KHHHHHHK....',
    '........KhhhhhhK....',
    '..KKKKKKKggggggK....',
    '.KrrrrrrKKssKshK....',
    '.KrrrrrrKKsssshK....',
    '.KPPpppKKBbbbbsK....',
    '.KPPpppKKBbBbbsK....',
    '.KPPpppKTBbBbbtK....',
    '.KPPpppKTBbBbbtK....',
    '.KPPppggTBbBbbttK...',
    '.KPPppllTBbBbbttK...',
    '.KPPppllTTBBBtttK...',
    '.KPPppllllllggltK...',
    '..KKKKMlllllgglK....',
    '....KMMKNNKKKKnnK...',
    '....KMMKNNK..KnnK...',
    '...KMMKKLLLK.KnnK...',
    '...KMMKKLLLK.KlllK..',
    '..KMMK..KKK..KlllK..',
    '...KK.........KKK...',
  ],
];
