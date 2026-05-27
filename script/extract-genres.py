#!/usr/bin/env python3
"""
extract-genres.py
Genre classification for albums in unzips/ using Essentia + TensorFlow.

Default pipeline (discogs400):
  MonoLoader → TensorflowPredictEffnetDiscogs → 400 Discogs style predictions

Fallback pipeline (dortmund, --model dortmund):
  MonoLoader → TensorflowPredictMusiCNN → TensorflowPredict2D → 9 genre predictions

Models downloaded automatically on first run to script/models/.

Usage:
  python3 script/extract-genres.py                            # all unclassified albums
  python3 script/extract-genres.py --albums "2012 - X" "Y"   # specific albums
  python3 script/extract-genres.py --random 3                 # N random albums
  python3 script/extract-genres.py --model dortmund           # use 9-class model instead
"""

import os
import sys
import json
import random
import contextlib
import urllib.request
import warnings
import time
from collections import deque
import numpy as np
from pathlib import Path

# Suppress harmless multiprocessing resource-tracker warnings on macOS
warnings.filterwarnings('ignore', message='resource_tracker.*')

UNZIPS    = Path(os.environ.get('ARCHIVE_DIR', Path(__file__).parent.parent / 'unzips'))
OUTPUT    = Path(os.environ.get('OUTPUT_FILE', Path(__file__).parent.parent / 'genres.json'))
MODEL_DIR = Path(__file__).parent / 'models'

MODELS = {
    'effnet': {
        'url':  'https://essentia.upf.edu/models/feature-extractors/discogs-effnet/discogs-effnet-bs64-1.pb',
        'file': 'discogs-effnet-bs64-1.pb',
    },
    'discogs400': {
        'url':  'https://essentia.upf.edu/models/classification-heads/genre_discogs400/genre_discogs400-discogs-effnet-1.pb',
        'file': 'genre_discogs400-discogs-effnet-1.pb',
    },
    'musicnn': {
        'url':  'https://essentia.upf.edu/models/feature-extractors/musicnn/msd-musicnn-1.pb',
        'file': 'msd-musicnn-1.pb',
    },
    'dortmund': {
        'url':  'https://essentia.upf.edu/models/classification-heads/genre_dortmund/genre_dortmund-msd-musicnn-1.pb',
        'file': 'genre_dortmund-msd-musicnn-1.pb',
    },
    'maest': {
        'url':  'https://essentia.upf.edu/models/feature-extractors/maest/discogs-maest-30s-pw-519l-1.pb',
        'file': 'discogs-maest-30s-pw-519l-1.pb',
    },
    'discogs519': {
        'url':  'https://essentia.upf.edu/models/classification-heads/genre_discogs519/genre_discogs519-discogs-maest-30s-pw-519l-1.pb',
        'file': 'genre_discogs519-discogs-maest-30s-pw-519l-1.pb',
    },
}

DORTMUND_LABELS = [
    'alternative', 'blues', 'electronic', 'folkcountry',
    'funsolnovelty', 'jazzblues', 'poprock', 'raphiphop', 'religious',
]

DISCOGS400_LABELS = [
    "Blues---Boogie Woogie","Blues---Chicago Blues","Blues---Country Blues","Blues---Delta Blues",
    "Blues---Electric Blues","Blues---Harmonica Blues","Blues---Jump Blues","Blues---Louisiana Blues",
    "Blues---Modern Electric Blues","Blues---Piano Blues","Blues---Rhythm & Blues","Blues---Texas Blues",
    "Brass & Military---Brass Band","Brass & Military---Marches","Brass & Military---Military",
    "Children's---Educational","Children's---Nursery Rhymes","Children's---Story",
    "Classical---Baroque","Classical---Choral","Classical---Classical","Classical---Contemporary",
    "Classical---Impressionist","Classical---Medieval","Classical---Modern","Classical---Neo-Classical",
    "Classical---Neo-Romantic","Classical---Opera","Classical---Post-Modern","Classical---Renaissance",
    "Classical---Romantic","Electronic---Abstract","Electronic---Acid","Electronic---Acid House",
    "Electronic---Acid Jazz","Electronic---Ambient","Electronic---Bassline","Electronic---Beatdown",
    "Electronic---Berlin-School","Electronic---Big Beat","Electronic---Bleep","Electronic---Breakbeat",
    "Electronic---Breakcore","Electronic---Breaks","Electronic---Broken Beat","Electronic---Chillwave",
    "Electronic---Chiptune","Electronic---Dance-pop","Electronic---Dark Ambient","Electronic---Darkwave",
    "Electronic---Deep House","Electronic---Deep Techno","Electronic---Disco","Electronic---Disco Polo",
    "Electronic---Donk","Electronic---Downtempo","Electronic---Drone","Electronic---Drum n Bass",
    "Electronic---Dub","Electronic---Dub Techno","Electronic---Dubstep","Electronic---Dungeon Synth",
    "Electronic---EBM","Electronic---Electro","Electronic---Electro House","Electronic---Electroclash",
    "Electronic---Euro House","Electronic---Euro-Disco","Electronic---Eurobeat","Electronic---Eurodance",
    "Electronic---Experimental","Electronic---Freestyle","Electronic---Future Jazz","Electronic---Gabber",
    "Electronic---Garage House","Electronic---Ghetto","Electronic---Ghetto House","Electronic---Glitch",
    "Electronic---Goa Trance","Electronic---Grime","Electronic---Halftime","Electronic---Hands Up",
    "Electronic---Happy Hardcore","Electronic---Hard House","Electronic---Hard Techno",
    "Electronic---Hard Trance","Electronic---Hardcore","Electronic---Hardstyle","Electronic---Hi NRG",
    "Electronic---Hip Hop","Electronic---Hip-House","Electronic---House","Electronic---IDM",
    "Electronic---Illbient","Electronic---Industrial","Electronic---Italo House","Electronic---Italo-Disco",
    "Electronic---Italodance","Electronic---Jazzdance","Electronic---Juke","Electronic---Jumpstyle",
    "Electronic---Jungle","Electronic---Latin","Electronic---Leftfield","Electronic---Makina",
    "Electronic---Minimal","Electronic---Minimal Techno","Electronic---Modern Classical",
    "Electronic---Musique Concrète","Electronic---Neofolk","Electronic---New Age","Electronic---New Beat",
    "Electronic---New Wave","Electronic---Noise","Electronic---Nu-Disco","Electronic---Power Electronics",
    "Electronic---Progressive Breaks","Electronic---Progressive House","Electronic---Progressive Trance",
    "Electronic---Psy-Trance","Electronic---Rhythmic Noise","Electronic---Schranz",
    "Electronic---Sound Collage","Electronic---Speed Garage","Electronic---Speedcore",
    "Electronic---Synth-pop","Electronic---Synthwave","Electronic---Tech House","Electronic---Tech Trance",
    "Electronic---Techno","Electronic---Trance","Electronic---Tribal","Electronic---Tribal House",
    "Electronic---Trip Hop","Electronic---Tropical House","Electronic---UK Garage","Electronic---Vaporwave",
    "Folk, World, & Country---African","Folk, World, & Country---Bluegrass","Folk, World, & Country---Cajun",
    "Folk, World, & Country---Canzone Napoletana","Folk, World, & Country---Catalan Music",
    "Folk, World, & Country---Celtic","Folk, World, & Country---Country","Folk, World, & Country---Fado",
    "Folk, World, & Country---Flamenco","Folk, World, & Country---Folk","Folk, World, & Country---Gospel",
    "Folk, World, & Country---Highlife","Folk, World, & Country---Hillbilly",
    "Folk, World, & Country---Hindustani","Folk, World, & Country---Honky Tonk",
    "Folk, World, & Country---Indian Classical","Folk, World, & Country---Laïkó",
    "Folk, World, & Country---Nordic","Folk, World, & Country---Pacific","Folk, World, & Country---Polka",
    "Folk, World, & Country---Raï","Folk, World, & Country---Romani","Folk, World, & Country---Soukous",
    "Folk, World, & Country---Séga","Folk, World, & Country---Volksmusik","Folk, World, & Country---Zouk",
    "Folk, World, & Country---Éntekhno","Funk / Soul---Afrobeat","Funk / Soul---Boogie",
    "Funk / Soul---Contemporary R&B","Funk / Soul---Disco","Funk / Soul---Free Funk","Funk / Soul---Funk",
    "Funk / Soul---Gospel","Funk / Soul---Neo Soul","Funk / Soul---New Jack Swing","Funk / Soul---P.Funk",
    "Funk / Soul---Psychedelic","Funk / Soul---Rhythm & Blues","Funk / Soul---Soul",
    "Funk / Soul---Swingbeat","Funk / Soul---UK Street Soul","Hip Hop---Bass Music","Hip Hop---Boom Bap",
    "Hip Hop---Bounce","Hip Hop---Britcore","Hip Hop---Cloud Rap","Hip Hop---Conscious","Hip Hop---Crunk",
    "Hip Hop---Cut-up/DJ","Hip Hop---DJ Battle Tool","Hip Hop---Electro","Hip Hop---G-Funk",
    "Hip Hop---Gangsta","Hip Hop---Grime","Hip Hop---Hardcore Hip-Hop","Hip Hop---Horrorcore",
    "Hip Hop---Instrumental","Hip Hop---Jazzy Hip-Hop","Hip Hop---Miami Bass","Hip Hop---Pop Rap",
    "Hip Hop---Ragga HipHop","Hip Hop---RnB/Swing","Hip Hop---Screw","Hip Hop---Thug Rap",
    "Hip Hop---Trap","Hip Hop---Trip Hop","Hip Hop---Turntablism","Jazz---Afro-Cuban Jazz",
    "Jazz---Afrobeat","Jazz---Avant-garde Jazz","Jazz---Big Band","Jazz---Bop","Jazz---Bossa Nova",
    "Jazz---Contemporary Jazz","Jazz---Cool Jazz","Jazz---Dixieland","Jazz---Easy Listening",
    "Jazz---Free Improvisation","Jazz---Free Jazz","Jazz---Fusion","Jazz---Gypsy Jazz","Jazz---Hard Bop",
    "Jazz---Jazz-Funk","Jazz---Jazz-Rock","Jazz---Latin Jazz","Jazz---Modal","Jazz---Post Bop",
    "Jazz---Ragtime","Jazz---Smooth Jazz","Jazz---Soul-Jazz","Jazz---Space-Age","Jazz---Swing",
    "Latin---Afro-Cuban","Latin---Baião","Latin---Batucada","Latin---Beguine","Latin---Bolero",
    "Latin---Boogaloo","Latin---Bossanova","Latin---Cha-Cha","Latin---Charanga","Latin---Compas",
    "Latin---Cubano","Latin---Cumbia","Latin---Descarga","Latin---Forró","Latin---Guaguancó",
    "Latin---Guajira","Latin---Guaracha","Latin---MPB","Latin---Mambo","Latin---Mariachi",
    "Latin---Merengue","Latin---Norteño","Latin---Nueva Cancion","Latin---Pachanga","Latin---Porro",
    "Latin---Ranchera","Latin---Reggaeton","Latin---Rumba","Latin---Salsa","Latin---Samba",
    "Latin---Son","Latin---Son Montuno","Latin---Tango","Latin---Tejano","Latin---Vallenato",
    "Non-Music---Audiobook","Non-Music---Comedy","Non-Music---Dialogue","Non-Music---Education",
    "Non-Music---Field Recording","Non-Music---Interview","Non-Music---Monolog","Non-Music---Poetry",
    "Non-Music---Political","Non-Music---Promotional","Non-Music---Radioplay","Non-Music---Religious",
    "Non-Music---Spoken Word","Pop---Ballad","Pop---Bollywood","Pop---Bubblegum","Pop---Chanson",
    "Pop---City Pop","Pop---Europop","Pop---Indie Pop","Pop---J-pop","Pop---K-pop","Pop---Kayōkyoku",
    "Pop---Light Music","Pop---Music Hall","Pop---Novelty","Pop---Parody","Pop---Schlager","Pop---Vocal",
    "Reggae---Calypso","Reggae---Dancehall","Reggae---Dub","Reggae---Lovers Rock","Reggae---Ragga",
    "Reggae---Reggae","Reggae---Reggae-Pop","Reggae---Rocksteady","Reggae---Roots Reggae","Reggae---Ska",
    "Reggae---Soca","Rock---AOR","Rock---Acid Rock","Rock---Acoustic","Rock---Alternative Rock",
    "Rock---Arena Rock","Rock---Art Rock","Rock---Atmospheric Black Metal","Rock---Avantgarde",
    "Rock---Beat","Rock---Black Metal","Rock---Blues Rock","Rock---Brit Pop","Rock---Classic Rock",
    "Rock---Coldwave","Rock---Country Rock","Rock---Crust","Rock---Death Metal","Rock---Deathcore",
    "Rock---Deathrock","Rock---Depressive Black Metal","Rock---Doo Wop","Rock---Doom Metal",
    "Rock---Dream Pop","Rock---Emo","Rock---Ethereal","Rock---Experimental","Rock---Folk Metal",
    "Rock---Folk Rock","Rock---Funeral Doom Metal","Rock---Funk Metal","Rock---Garage Rock",
    "Rock---Glam","Rock---Goregrind","Rock---Goth Rock","Rock---Gothic Metal","Rock---Grindcore",
    "Rock---Grunge","Rock---Hard Rock","Rock---Hardcore","Rock---Heavy Metal","Rock---Indie Rock",
    "Rock---Industrial","Rock---Krautrock","Rock---Lo-Fi","Rock---Lounge","Rock---Math Rock",
    "Rock---Melodic Death Metal","Rock---Melodic Hardcore","Rock---Metalcore","Rock---Mod",
    "Rock---Neofolk","Rock---New Wave","Rock---No Wave","Rock---Noise","Rock---Noisecore",
    "Rock---Nu Metal","Rock---Oi","Rock---Parody","Rock---Pop Punk","Rock---Pop Rock",
    "Rock---Pornogrind","Rock---Post Rock","Rock---Post-Hardcore","Rock---Post-Metal",
    "Rock---Post-Punk","Rock---Power Metal","Rock---Power Pop","Rock---Power Violence",
    "Rock---Prog Rock","Rock---Progressive Metal","Rock---Psychedelic Rock","Rock---Psychobilly",
    "Rock---Pub Rock","Rock---Punk","Rock---Rock & Roll","Rock---Rockabilly","Rock---Shoegaze",
    "Rock---Ska","Rock---Sludge Metal","Rock---Soft Rock","Rock---Southern Rock","Rock---Space Rock",
    "Rock---Speed Metal","Rock---Stoner Rock","Rock---Surf","Rock---Symphonic Rock",
    "Rock---Technical Death Metal","Rock---Thrash","Rock---Twist","Rock---Viking Metal","Rock---Yé-Yé",
    "Stage & Screen---Musical","Stage & Screen---Score","Stage & Screen---Soundtrack",
    "Stage & Screen---Theme",
]

DISCOGS519_LABELS = [
    "Blues---Boogie Woogie","Blues---Chicago Blues","Blues---Country Blues","Blues---Delta Blues",
    "Blues---East Coast Blues","Blues---Electric Blues","Blues---Harmonica Blues","Blues---Jump Blues",
    "Blues---Louisiana Blues","Blues---Memphis Blues","Blues---Modern Electric Blues","Blues---Piano Blues",
    "Blues---Piedmont Blues","Blues---Rhythm & Blues","Blues---Texas Blues",
    "Brass & Military---Brass Band","Brass & Military---Marches","Brass & Military---Military",
    "Brass & Military---Pipe & Drum","Children's---Educational","Children's---Nursery Rhymes",
    "Children's---Story","Classical---Baroque","Classical---Choral","Classical---Classical",
    "Classical---Contemporary","Classical---Early","Classical---Impressionist","Classical---Medieval",
    "Classical---Modern","Classical---Neo-Classical","Classical---Neo-Romantic","Classical---Opera",
    "Classical---Operetta","Classical---Oratorio","Classical---Post-Modern","Classical---Renaissance",
    "Classical---Romantic","Classical---Twelve-tone","Electronic---Abstract","Electronic---Acid",
    "Electronic---Acid House","Electronic---Acid Jazz","Electronic---Ambient","Electronic---Baltimore Club",
    "Electronic---Bassline","Electronic---Beatdown","Electronic---Berlin-School","Electronic---Big Beat",
    "Electronic---Bleep","Electronic---Breakbeat","Electronic---Breakcore","Electronic---Breaks",
    "Electronic---Broken Beat","Electronic---Chillwave","Electronic---Chiptune","Electronic---Dance-pop",
    "Electronic---Dark Ambient","Electronic---Darkwave","Electronic---Deep House","Electronic---Deep Techno",
    "Electronic---Disco","Electronic---Disco Polo","Electronic---Donk","Electronic---Doomcore",
    "Electronic---Downtempo","Electronic---Drone","Electronic---Drum n Bass","Electronic---Dub",
    "Electronic---Dub Techno","Electronic---Dubstep","Electronic---Dungeon Synth","Electronic---EBM",
    "Electronic---Electro","Electronic---Electro House","Electronic---Electroacoustic","Electronic---Electroclash",
    "Electronic---Euro House","Electronic---Euro-Disco","Electronic---Eurobeat","Electronic---Eurodance",
    "Electronic---Experimental","Electronic---Footwork","Electronic---Freestyle","Electronic---Future Jazz",
    "Electronic---Gabber","Electronic---Garage House","Electronic---Ghetto","Electronic---Ghetto House",
    "Electronic---Ghettotech","Electronic---Glitch","Electronic---Glitch Hop","Electronic---Goa Trance",
    "Electronic---Grime","Electronic---Halftime","Electronic---Hands Up","Electronic---Happy Hardcore",
    "Electronic---Hard Beat","Electronic---Hard House","Electronic---Hard Techno","Electronic---Hard Trance",
    "Electronic---Hardcore","Electronic---Hardstyle","Electronic---Harsh Noise Wall","Electronic---Hi NRG",
    "Electronic---Hip Hop","Electronic---Hip-House","Electronic---House","Electronic---IDM",
    "Electronic---Illbient","Electronic---Industrial","Electronic---Italo House","Electronic---Italo-Disco",
    "Electronic---Italodance","Electronic---J-Core","Electronic---Jazzdance","Electronic---Juke",
    "Electronic---Jumpstyle","Electronic---Jungle","Electronic---Latin","Electronic---Leftfield",
    "Electronic---Lento Violento","Electronic---Makina","Electronic---Minimal","Electronic---Minimal Techno",
    "Electronic---Modern Classical","Electronic---Musique Concrète","Electronic---Neo Trance",
    "Electronic---Neofolk","Electronic---New Age","Electronic---New Beat","Electronic---New Wave",
    "Electronic---Noise","Electronic---Nu-Disco","Electronic---Power Electronics","Electronic---Progressive Breaks",
    "Electronic---Progressive House","Electronic---Progressive Trance","Electronic---Psy-Trance",
    "Electronic---Rhythmic Noise","Electronic---Schranz","Electronic---Sound Collage","Electronic---Speed Garage",
    "Electronic---Speedcore","Electronic---Synth-pop","Electronic---Synthwave","Electronic---Tech House",
    "Electronic---Tech Trance","Electronic---Techno","Electronic---Trance","Electronic---Tribal",
    "Electronic---Tribal House","Electronic---Trip Hop","Electronic---Tropical House","Electronic---UK Funky",
    "Electronic---UK Garage","Electronic---Vaporwave","Electronic---Witch House",
    "Folk, World, & Country---Aboriginal","Folk, World, & Country---African",
    "Folk, World, & Country---Andalusian Classical","Folk, World, & Country---Andean Music",
    "Folk, World, & Country---Appalachian Music","Folk, World, & Country---Basque Music",
    "Folk, World, & Country---Bhangra","Folk, World, & Country---Bluegrass","Folk, World, & Country---Cajun",
    "Folk, World, & Country---Canzone Napoletana","Folk, World, & Country---Carnatic",
    "Folk, World, & Country---Catalan Music","Folk, World, & Country---Celtic","Folk, World, & Country---Chacarera",
    "Folk, World, & Country---Chinese Classical","Folk, World, & Country---Chutney",
    "Folk, World, & Country---Copla","Folk, World, & Country---Country","Folk, World, & Country---Cretan",
    "Folk, World, & Country---Dangdut","Folk, World, & Country---Fado","Folk, World, & Country---Flamenco",
    "Folk, World, & Country---Folk","Folk, World, & Country---Funaná","Folk, World, & Country---Gamelan",
    "Folk, World, & Country---Ghazal","Folk, World, & Country---Gospel","Folk, World, & Country---Griot",
    "Folk, World, & Country---Hawaiian","Folk, World, & Country---Highlife","Folk, World, & Country---Hillbilly",
    "Folk, World, & Country---Hindustani","Folk, World, & Country---Honky Tonk",
    "Folk, World, & Country---Indian Classical","Folk, World, & Country---Kaseko",
    "Folk, World, & Country---Klezmer","Folk, World, & Country---Laïkó","Folk, World, & Country---Luk Thung",
    "Folk, World, & Country---Maloya","Folk, World, & Country---Mbalax","Folk, World, & Country---Min'yō",
    "Folk, World, & Country---Mizrahi","Folk, World, & Country---Nhạc Vàng","Folk, World, & Country---Nordic",
    "Folk, World, & Country---Népzene","Folk, World, & Country---Ottoman Classical",
    "Folk, World, & Country---Overtone Singing","Folk, World, & Country---Pacific",
    "Folk, World, & Country---Pasodoble","Folk, World, & Country---Persian Classical",
    "Folk, World, & Country---Phleng Phuea Chiwit","Folk, World, & Country---Polka",
    "Folk, World, & Country---Qawwali","Folk, World, & Country---Raï","Folk, World, & Country---Rebetiko",
    "Folk, World, & Country---Romani","Folk, World, & Country---Salegy","Folk, World, & Country---Sea Shanties",
    "Folk, World, & Country---Soukous","Folk, World, & Country---Séga","Folk, World, & Country---Volksmusik",
    "Folk, World, & Country---Western Swing","Folk, World, & Country---Zouk","Folk, World, & Country---Zydeco",
    "Folk, World, & Country---Éntekhno","Funk / Soul---Afrobeat","Funk / Soul---Bayou Funk",
    "Funk / Soul---Boogie","Funk / Soul---Contemporary R&B","Funk / Soul---Disco","Funk / Soul---Free Funk",
    "Funk / Soul---Funk","Funk / Soul---Gogo","Funk / Soul---Gospel","Funk / Soul---Minneapolis Sound",
    "Funk / Soul---Neo Soul","Funk / Soul---New Jack Swing","Funk / Soul---P.Funk","Funk / Soul---Psychedelic",
    "Funk / Soul---Rhythm & Blues","Funk / Soul---Soul","Funk / Soul---Swingbeat","Funk / Soul---UK Street Soul",
    "Hip Hop---Bass Music","Hip Hop---Beatbox","Hip Hop---Boom Bap","Hip Hop---Bounce","Hip Hop---Britcore",
    "Hip Hop---Cloud Rap","Hip Hop---Conscious","Hip Hop---Crunk","Hip Hop---Cut-up/DJ",
    "Hip Hop---DJ Battle Tool","Hip Hop---Electro","Hip Hop---Favela Funk","Hip Hop---G-Funk",
    "Hip Hop---Gangsta","Hip Hop---Go-Go","Hip Hop---Grime","Hip Hop---Hardcore Hip-Hop",
    "Hip Hop---Hiplife","Hip Hop---Horrorcore","Hip Hop---Hyphy","Hip Hop---Instrumental",
    "Hip Hop---Jazzy Hip-Hop","Hip Hop---Kwaito","Hip Hop---Miami Bass","Hip Hop---Pop Rap",
    "Hip Hop---Ragga HipHop","Hip Hop---RnB/Swing","Hip Hop---Screw","Hip Hop---Thug Rap",
    "Hip Hop---Trap","Hip Hop---Trip Hop","Hip Hop---Turntablism","Jazz---Afro-Cuban Jazz",
    "Jazz---Afrobeat","Jazz---Avant-garde Jazz","Jazz---Big Band","Jazz---Bop","Jazz---Bossa Nova",
    "Jazz---Cape Jazz","Jazz---Contemporary Jazz","Jazz---Cool Jazz","Jazz---Dixieland","Jazz---Easy Listening",
    "Jazz---Free Improvisation","Jazz---Free Jazz","Jazz---Fusion","Jazz---Gypsy Jazz","Jazz---Hard Bop",
    "Jazz---Jazz-Funk","Jazz---Jazz-Rock","Jazz---Latin Jazz","Jazz---Modal","Jazz---Post Bop",
    "Jazz---Ragtime","Jazz---Smooth Jazz","Jazz---Soul-Jazz","Jazz---Space-Age","Jazz---Swing",
    "Latin---Afro-Cuban","Latin---Axé","Latin---Bachata","Latin---Baião","Latin---Batucada",
    "Latin---Beguine","Latin---Bolero","Latin---Boogaloo","Latin---Bossanova","Latin---Carimbó",
    "Latin---Cha-Cha","Latin---Charanga","Latin---Choro","Latin---Compas","Latin---Conjunto",
    "Latin---Corrido","Latin---Cubano","Latin---Cumbia","Latin---Danzon","Latin---Descarga",
    "Latin---Forró","Latin---Gaita","Latin---Guaguancó","Latin---Guajira","Latin---Guaracha",
    "Latin---Jibaro","Latin---Lambada","Latin---MPB","Latin---Mambo","Latin---Mariachi","Latin---Marimba",
    "Latin---Merengue","Latin---Música Criolla","Latin---Norteño","Latin---Nueva Cancion","Latin---Nueva Trova",
    "Latin---Pachanga","Latin---Plena","Latin---Porro","Latin---Quechua","Latin---Ranchera",
    "Latin---Reggaeton","Latin---Rumba","Latin---Salsa","Latin---Samba","Latin---Samba-Canção",
    "Latin---Son","Latin---Son Montuno","Latin---Sonero","Latin---Tango","Latin---Tejano","Latin---Timba",
    "Latin---Trova","Latin---Vallenato","Non-Music---Audiobook","Non-Music---Comedy",
    "Non-Music---Dialogue","Non-Music---Education","Non-Music---Erotic","Non-Music---Field Recording",
    "Non-Music---Health-Fitness","Non-Music---Interview","Non-Music---Monolog","Non-Music---Movie Effects",
    "Non-Music---Poetry","Non-Music---Political","Non-Music---Promotional","Non-Music---Public Broadcast",
    "Non-Music---Radioplay","Non-Music---Religious","Non-Music---Sermon","Non-Music---Sound Art",
    "Non-Music---Sound Poetry","Non-Music---Special Effects","Non-Music---Speech","Non-Music---Spoken Word",
    "Non-Music---Technical","Non-Music---Therapy","Pop---Ballad","Pop---Barbershop","Pop---Bollywood",
    "Pop---Break-In","Pop---Bubblegum","Pop---Chanson","Pop---City Pop","Pop---Enka","Pop---Ethno-pop",
    "Pop---Europop","Pop---Indie Pop","Pop---J-pop","Pop---K-pop","Pop---Karaoke","Pop---Kayōkyoku",
    "Pop---Levenslied","Pop---Light Music","Pop---Music Hall","Pop---Novelty","Pop---Parody",
    "Pop---Schlager","Pop---Vocal","Reggae---Calypso","Reggae---Dancehall","Reggae---Dub",
    "Reggae---Dub Poetry","Reggae---Lovers Rock","Reggae---Mento","Reggae---Ragga","Reggae---Reggae",
    "Reggae---Reggae Gospel","Reggae---Reggae-Pop","Reggae---Rocksteady","Reggae---Roots Reggae",
    "Reggae---Ska","Reggae---Soca","Reggae---Steel Band","Rock---AOR","Rock---Acid Rock","Rock---Acoustic",
    "Rock---Alternative Rock","Rock---Arena Rock","Rock---Art Rock","Rock---Atmospheric Black Metal",
    "Rock---Avantgarde","Rock---Beat","Rock---Black Metal","Rock---Blues Rock","Rock---Brit Pop",
    "Rock---Classic Rock","Rock---Coldwave","Rock---Country Rock","Rock---Crust","Rock---Death Metal",
    "Rock---Deathcore","Rock---Deathrock","Rock---Depressive Black Metal","Rock---Doo Wop",
    "Rock---Doom Metal","Rock---Dream Pop","Rock---Emo","Rock---Ethereal","Rock---Experimental",
    "Rock---Folk Metal","Rock---Folk Rock","Rock---Funeral Doom Metal","Rock---Funk Metal",
    "Rock---Garage Rock","Rock---Glam","Rock---Goregrind","Rock---Goth Rock","Rock---Gothic Metal",
    "Rock---Grindcore","Rock---Groove Metal","Rock---Grunge","Rock---Hard Rock","Rock---Hardcore",
    "Rock---Heavy Metal","Rock---Horror Rock","Rock---Indie Rock","Rock---Industrial","Rock---Industrial Metal",
    "Rock---J-Rock","Rock---Jangle Pop","Rock---K-Rock","Rock---Krautrock","Rock---Lo-Fi",
    "Rock---Lounge","Rock---Math Rock","Rock---Melodic Death Metal","Rock---Melodic Hardcore",
    "Rock---Metalcore","Rock---Mod","Rock---NDW","Rock---Neofolk","Rock---New Wave","Rock---No Wave",
    "Rock---Noise","Rock---Noisecore","Rock---Nu Metal","Rock---Oi","Rock---Parody","Rock---Pop Punk",
    "Rock---Pop Rock","Rock---Pornogrind","Rock---Post Rock","Rock---Post-Hardcore","Rock---Post-Metal",
    "Rock---Post-Punk","Rock---Power Metal","Rock---Power Pop","Rock---Power Violence","Rock---Prog Rock",
    "Rock---Progressive Metal","Rock---Psychedelic Rock","Rock---Psychobilly","Rock---Pub Rock",
    "Rock---Punk","Rock---Rock & Roll","Rock---Rock Opera","Rock---Rockabilly","Rock---Shoegaze",
    "Rock---Ska","Rock---Skiffle","Rock---Sludge Metal","Rock---Soft Rock","Rock---Southern Rock",
    "Rock---Space Rock","Rock---Speed Metal","Rock---Stoner Rock","Rock---Surf","Rock---Swamp Pop",
    "Rock---Symphonic Rock","Rock---Technical Death Metal","Rock---Thrash","Rock---Twist",
    "Rock---Viking Metal","Rock---Yé-Yé","Stage & Screen---Musical","Stage & Screen---Score",
    "Stage & Screen---Soundtrack","Stage & Screen---Theme",
]

# Suppress TF C++ and Essentia log noise before any imports
os.environ.setdefault('TF_CPP_MIN_LOG_LEVEL', '3')
os.environ.setdefault('GLOG_minloglevel', '3')

MAEST_SR     = 16000   # sample rate shared by all three model pipelines
AUDIO_CLIP_S = 30      # seconds to sample per track (MAEST's design window)

# Per-process predictor cache — avoids reloading the TF graph on every track
_PRED_CACHE: dict = {}


class UnreadableAudio(Exception):
    pass


def _audio_worker(mp3_path: str, q):
    """Load audio in a subprocess (module-level for pickling)."""
    try:
        audio = _do_load_audio(Path(mp3_path))
        q.put(('ok', audio))
    except Exception as e:
        q.put(('error', e))


def _load_audio_with_timeout(mp3: Path, timeout_s: float = 15.0) -> np.ndarray:
    import multiprocessing as _mp
    from multiprocessing import Queue as _mpQueue
    from queue import Empty as _QueueEmpty
    q = _mpQueue()
    p = _mp.Process(target=_audio_worker, args=(str(mp3), q))
    p.start()
    try:
        status, result = q.get(timeout=timeout_s)
    except _QueueEmpty:
        if p.is_alive():
            p.terminate()
            p.join()
        q.close()
        q.join_thread()
        raise TimeoutError(f'Audio loading timed out after {timeout_s}s')
    p.join(timeout=5)
    q.close()
    q.join_thread()
    if status == 'error':
        raise result
    return result


def _do_load_audio(mp3: Path) -> np.ndarray:
    import essentia.standard as es
    try:
        audio = es.MonoLoader(filename=str(mp3), sampleRate=MAEST_SR)()
    except RuntimeError as e:
        if 'swresample' in str(e) or 'AudioLoader' in str(e):
            raise UnreadableAudio(str(e)) from e
        raise
    limit = MAEST_SR * AUDIO_CLIP_S
    if len(audio) > limit:
        start = (len(audio) - limit) // 2
        audio = audio[start : start + limit]
    elif len(audio) < limit:
        audio = np.pad(audio, (0, limit - len(audio)))
    return audio



def _maest_pred():
    if 'maest' not in _PRED_CACHE:
        import essentia.standard as es
        _PRED_CACHE['maest'] = es.TensorflowPredictMAEST(
            graphFilename=str(MODEL_DIR / MODELS['maest']['file']),
            input='serving_default_melspectrogram',
            output='StatefulPartitionedCall:0',
            batchSize=-1,
        )
    return _PRED_CACHE['maest']


def _effnet_pred():
    if 'effnet' not in _PRED_CACHE:
        import essentia.standard as es
        _PRED_CACHE['effnet'] = es.TensorflowPredictEffnetDiscogs(
            graphFilename=str(MODEL_DIR / MODELS['effnet']['file']),
            output='PartitionedCall:0',
        )
    return _PRED_CACHE['effnet']


def _musicnn_pred():
    if 'musicnn' not in _PRED_CACHE:
        import essentia.standard as es
        _PRED_CACHE['musicnn'] = es.TensorflowPredictMusiCNN(
            graphFilename=str(MODEL_DIR / MODELS['musicnn']['file']),
            output='model/dense/BiasAdd',
        )
    return _PRED_CACHE['musicnn']


def _dortmund_pred():
    if 'dortmund' not in _PRED_CACHE:
        import essentia.standard as es
        _PRED_CACHE['dortmund'] = es.TensorflowPredict2D(
            graphFilename=str(MODEL_DIR / MODELS['dortmund']['file']),
            input='model/Placeholder', output='model/Softmax',
        )
    return _PRED_CACHE['dortmund']


def _quiet_essentia():
    try:
        import essentia
        essentia.log.infoActive    = False
        essentia.log.warningActive = False
    except Exception:
        pass


def download_models(model='discogs400'):
    MODEL_DIR.mkdir(exist_ok=True)
    if model == 'discogs519':
        keys = ['maest', 'discogs519']
    elif model == 'discogs400':
        keys = ['effnet', 'discogs400']
    else:
        keys = ['musicnn', 'dortmund']
    for key in keys:
        info = MODELS[key]
        dest = MODEL_DIR / info['file']
        if not dest.exists():
            print(f'Downloading {info["file"]}...', flush=True)
            urllib.request.urlretrieve(info['url'], dest)
            print(f'  ✓ {dest}')


def find_mp3s(album_dir: Path):
    return sorted(f for f in album_dir.iterdir() if f.suffix.lower() == '.mp3')


@contextlib.contextmanager
def _quiet_stderr():
    """Redirect fd 2 to /dev/null to suppress TF/absl C-level log spam."""
    devnull_fd = os.open(os.devnull, os.O_WRONLY)
    saved_fd   = os.dup(2)
    os.dup2(devnull_fd, 2)
    os.close(devnull_fd)
    try:
        yield
    finally:
        os.dup2(saved_fd, 2)
        os.close(saved_fd)


def _warm_up(model='discogs400'):
    """Prime the predictor cache while suppressing TF's one-time C-level init messages."""
    silence = np.zeros(MAEST_SR * AUDIO_CLIP_S, dtype=np.float32)
    with _quiet_stderr():
        try:
            if model == 'discogs519':
                _maest_pred()(silence)
            elif model == 'discogs400':
                _effnet_pred()(silence)
            else:
                _musicnn_pred()(silence)
        except Exception:
            pass


def _infer_discogs400(audio: np.ndarray):
    with _quiet_stderr():
        preds = _effnet_pred()(audio)
    if not len(preds):
        return None
    scores = np.mean(preds, axis=0)
    genres = sorted(
        [{'label': DISCOGS400_LABELS[i], 'score': round(float(scores[i]), 4)}
         for i in range(400)],
        key=lambda x: -x['score'],
    )
    return {'top': genres[0]['label'], 'genres': genres[:5]}


def _infer_discogs519(audio: np.ndarray):
    with _quiet_stderr():
        preds = _maest_pred()(audio)
    if preds is None or not len(preds.shape):
        return None
    scores = np.mean(np.array(preds).reshape(-1, 519), axis=0)
    genres = sorted(
        [{'label': DISCOGS519_LABELS[i], 'score': round(float(scores[i]), 4)}
         for i in range(519)],
        key=lambda x: -x['score'],
    )
    return {'top': genres[0]['label'], 'genres': genres[:5]}


def _infer_dortmund(audio: np.ndarray):
    with _quiet_stderr():
        embs = _musicnn_pred()(audio)
    if not len(embs):
        return None
    with _quiet_stderr():
        probs = _dortmund_pred()(np.mean(embs, axis=0).reshape(1, -1))
    scores = probs[0]
    genres = sorted(
        [{'label': DORTMUND_LABELS[i], 'score': round(float(scores[i]), 4)}
         for i in range(len(DORTMUND_LABELS))],
        key=lambda x: -x['score'],
    )
    return {'top': genres[0]['label'], 'genres': genres[:3]}


def _save_result(results: dict, album_name: str, result, output: Path = OUTPUT):
    """Atomically write in-memory results dict to disk (no re-read, atomic rename)."""
    results[album_name] = result
    tmp = output.with_suffix('.tmp')
    tmp.write_text(json.dumps(results, ensure_ascii=False))
    tmp.replace(output)


def _auto_workers() -> int:
    """Pick worker count for this machine: (cpu_count - 2), capped at 5."""
    cpus = os.cpu_count() or 4
    return max(2, min(cpus - 2, 5))


def _classify_album(album_name: str, infer_fn):
    album_dir = UNZIPS / album_name
    if not album_dir.is_dir():
        return album_name, None
    mp3s = find_mp3s(album_dir)
    if not mp3s:
        return album_name, None

    tracks = {}
    for mp3 in mp3s:
        try:
            result = infer_fn(_load_audio_with_timeout(mp3))
            if result:
                tracks[mp3.name] = result
        except (UnreadableAudio, TimeoutError, Exception) as e:
            print(f'  warn {mp3.name}: {e}', file=sys.stderr)

    return album_name, tracks or None


def classify_album_discogs400(album_name: str):
    return _classify_album(album_name, _infer_discogs400)


def classify_album_discogs519(album_name: str):
    return _classify_album(album_name, _infer_discogs519)


def classify_album_dortmund(album_name: str):
    return _classify_album(album_name, _infer_dortmund)


def _worker_init(model: str):
    """Pre-load and warm-up predictors in each worker process."""
    _quiet_essentia()
    _warm_up(model)


def main():
    args = sys.argv[1:]

    if '--model' in args:
        idx   = args.index('--model')
        model = args[idx + 1] if idx + 1 < len(args) else 'discogs400'
    else:
        model = 'discogs400'

    if '--workers' in args:
        idx = args.index('--workers')
        val = args[idx + 1] if idx + 1 < len(args) else 'auto'
        n_workers = _auto_workers() if val == 'auto' else int(val)
    else:
        n_workers = _auto_workers()

    if model == 'discogs519':
        classify_fn = classify_album_discogs519
    elif model == 'discogs400':
        classify_fn = classify_album_discogs400
    else:
        classify_fn = classify_album_dortmund

    test_mode   = False
    album_names = []
    if '--random' in args:
        test_mode = True
        idx = args.index('--random')
        n   = int(args[idx + 1]) if idx + 1 < len(args) and args[idx + 1].isdigit() else 3
        all_dirs    = [d.name for d in UNZIPS.iterdir() if d.is_dir()]
        album_names = random.sample(all_dirs, min(n, len(all_dirs)))
    elif '--albums' in args:
        test_mode   = True
        idx         = args.index('--albums')
        album_names = [a for a in args[idx + 1:] if not a.startswith('--')]
    else:
        results     = json.loads(OUTPUT.read_text()) if OUTPUT.exists() else {}
        all_dirs    = [d.name for d in UNZIPS.iterdir() if d.is_dir()]
        album_names = [n for n in all_dirs if n not in results]
        print(f'Resuming: {len(album_names)} remaining ({len(results)} done)')

    _quiet_essentia()
    download_models(model)
    _warm_up(model)   # also primes _PRED_CACHE for single-process runs

    if test_mode:
        results = {}
    total = len(album_names)
    ordering = {name: i for i, name in enumerate(album_names, 1)}

    def _fmt_eta(remaining: int, rate_per_s: float) -> str:
        if rate_per_s <= 0:
            return '?'
        eta_s = remaining / rate_per_s
        h, m = int(eta_s // 3600), int((eta_s % 3600) // 60)
        return f'{h}h{m:02d}m'

    if n_workers > 1:
        from concurrent.futures import ProcessPoolExecutor, as_completed
        print(f'Running with {n_workers} workers...', flush=True)
        wall_start = time.time()
        completed  = 0
        with ProcessPoolExecutor(
            max_workers=n_workers,
            initializer=_worker_init,
            initargs=(model,),
        ) as pool:
            futures = {pool.submit(classify_fn, name): name for name in album_names}
            for fut in as_completed(futures):
                album_name, result = fut.result()
                completed += 1
                wall_elapsed = time.time() - wall_start
                rate = completed / wall_elapsed
                eta  = _fmt_eta(total - completed, rate)
                i    = ordering[album_name]
                print(f'[{i}/{total}] {album_name}', flush=True)
                if result:
                    if not test_mode:
                        _save_result(results, album_name, result, OUTPUT)
                    else:
                        results[album_name] = result
                    tops = ', '.join(set(v['top'] for v in result.values()))
                    print(f'  → {len(result)} tracks  {tops}  [{rate*60:.1f}/min | ETA {eta}]')
                else:
                    print(f'  → no audio  [{rate*60:.1f}/min | ETA {eta}]')
    else:
        times: deque = deque(maxlen=20)
        for i, name in enumerate(album_names, 1):
            t0 = time.time()
            print(f'[{i}/{total}] {name}', flush=True)
            _, result = classify_fn(name)
            elapsed = time.time() - t0
            times.append(elapsed)
            rate = len(times) / sum(times)
            eta  = _fmt_eta(total - i, rate)
            if result:
                if not test_mode:
                    _save_result(results, name, result, OUTPUT)
                else:
                    results[name] = result
                tops = ', '.join(set(v['top'] for v in result.values()))
                print(f'  → {len(result)} tracks  {tops}  [{elapsed:.1f}s | {rate*60:.1f}/min | ETA {eta}]')
            else:
                print(f'  → no audio  [{elapsed:.1f}s | {rate*60:.1f}/min | ETA {eta}]')

    if test_mode:
        print(json.dumps(results, ensure_ascii=False, indent=2))
    else:
        print(f'\n✓ {len(results)} total in {OUTPUT}')


if __name__ == '__main__':
    main()
