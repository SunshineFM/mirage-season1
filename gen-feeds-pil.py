from PIL import Image, ImageDraw, ImageFont
import os

# Create screenshots directory
os.makedirs('public/archive/screenshots', exist_ok=True)

# Colors from Mirage app
SKY_BLUE = (2, 132, 199)  # #0284C7
GOLD = (245, 158, 11)  # #F59E0B
WHITE = (255, 255, 255)
LIGHT_BLUE = (224, 242, 254)  # #E0F2FE
INK = (15, 23, 42)  # #0F172A
INK_MUTED = (71, 85, 105)  # #475569
BORDER = (226, 232, 240)  # #E2E8F0

# 9:16 portrait - use 375x667 as base (iPhone SE-ish)
WIDTH = 375
HEIGHT = int(WIDTH * 16 / 9)  # ~667

def draw_rounded_rect(draw, xy, radius, fill, outline=None, width=1):
    x1, y1, x2, y2 = xy
    r = radius
    draw.rectangle([x1+r, y1, x2-r, y2], fill=fill, outline=outline)
    draw.rectangle([x1, y1+r, x2, y2-r], fill=fill, outline=outline)
    draw.pieslice([x1, y1, x1+2*r, y1+2*r], 180, 270, fill=fill, outline=outline)
    draw.pieslice([x2-2*r, y1, x2, y1+2*r], 270, 360, fill=fill, outline=outline)
    draw.pieslice([x1, y2-2*r, x1+2*r, y2], 90, 180, fill=fill, outline=outline)
    draw.pieslice([x2-2*r, y2-2*r, x2, y2], 0, 90, fill=fill, outline=outline)

def make_font(size, bold=False):
    try:
        if bold:
            return ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', size)
        return ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', size)
    except:
        return ImageFont.load_default()

def draw_post_card(draw, y, nickname, location, text, reactions, font, font_small, font_tiny):
    # Card background
    card_padding = 14
    card_top = y
    card_bottom = y + 110
    draw_rounded_rect(draw, (16, card_top, WIDTH-16, card_bottom), 10, WHITE, BORDER, 1)

    # Location badge
    badge_color = SKY_BLUE
    draw_rounded_rect(draw, (28, card_top + 14, 28 + 90, card_top + 30), 6, LIGHT_BLUE)
    draw.text((34, card_top + 15), f'@{nickname}', fill=SKY_BLUE, font=font_small)
    draw.text((100, card_top + 15), f'  {location}', fill=INK_MUTED, font=font_tiny)

    # Post text
    text_top = card_top + 38
    lines = []
    words = text.split()
    line = ''
    for word in words:
        test = (line + ' ' + word).strip()
        if font.getlength(test) > WIDTH - 60:
            lines.append(line)
            line = word
        else:
            line = test
    if line:
        lines.append(line)

    for i, line_text in enumerate(lines[:3]):
        draw.text((28, text_top + i * 16), line_text, fill=INK, font=font)

    # Reactions
    reaction_top = card_top + 78
    for i, (emoji, count) in enumerate(reactions):
        rx = 28 + i * 70
        draw.text((rx, reaction_top), f'{emoji} {count}', fill=INK_MUTED, font=font_small)

def draw_feed_screenshot(filename, feed_title, feed_desc, posts, tab_labels):
    img = Image.new('RGB', (WIDTH, HEIGHT), WHITE)
    draw = ImageDraw.Draw(img)
    font_title = make_font(22, bold=True)
    font_large = make_font(16, bold=True)
    font = make_font(13)
    font_small = make_font(11)
    font_tiny = make_font(10)

    # Header
    header_h = 90
    draw.rectangle([0, 0, WIDTH, header_h], fill=SKY_BLUE)

    # App name
    draw.text((20, 20), 'mirage', fill=WHITE, font=make_font(28, bold=True))

    # Feed title
    draw.text((20, 56), feed_title, fill=WHITE, font=font_large)

    # Tab bar
    tab_bar_y = header_h
    tab_height = 44
    draw.rectangle([0, tab_bar_y, WIDTH, tab_bar_y + tab_height], fill=WHITE)

    tab_x = 20
    for i, label in enumerate(tab_labels):
        color = SKY_BLUE if i == 0 else INK_MUTED
        draw.text((tab_x, tab_bar_y + 12), label, fill=color, font=font_small)
        tab_x += 70

    # Swipe hint
    draw.text((WIDTH - 80, tab_bar_y + 12), 'swipe →', fill=INK_MUTED, font=font_tiny)

    # Feed description
    desc_y = header_h + tab_height + 14
    draw.text((20, desc_y), feed_desc, fill=INK_MUTED, font=font_small)

    # Posts
    post_y = desc_y + 28
    for post in posts:
        draw_post_card(draw, post_y, post['nickname'], post['location'], post['text'], post['reactions'], font, font_small, font_tiny)
        post_y += 120

    # Bottom UI hint
    hint_y = HEIGHT - 80
    draw.text((20, hint_y), 'tap any post to react 🌵', fill=INK_MUTED, font=font_small)

    img.save(filename)
    print(f'Saved: {filename}')

# Feed 1: Good Shots
draw_feed_screenshot(
    'public/archive/screenshots/feed-01-good-shots.png',
    'Good Shots',
    'photos only — captions are optional',
    [
        {'nickname': 'dustfox_33', 'location': 'at the fest', 'text': 'sunset over the main stage just hit different tonight. nothing prepared me for this.',
         'reactions': [('💐', 12), ('🩵', 8), ('👏', 5)]},
        {'nickname': 'sageowl_4', 'location': 'in the desert', 'text': 'caught the art installation at golden hour. this is what it is all about.',
         'reactions': [('💐', 7), ('🩵', 4)]},
    ],
    ['Good Shots', 'Good Vibes', 'Good Tips', 'Hey Mirage']
)

# Feed 2: Good Vibes
draw_feed_screenshot(
    'public/archive/screenshots/feed-02-good-vibes.png',
    'Good Vibes',
    'leave some love — a kind word, a lyric, anything that lifts the mood',
    [
        {'nickname': 'cactusbird_7', 'location': 'at the fest', 'text': 'that set just changed something in me. grateful to be here. all of us, right now.',
         'reactions': [('💐', 18), ('🩵', 15)]},
        {'nickname': 'mesaowl_22', 'location': 'in the desert', 'text': 'strangers becoming friends at 2am in the desert. this is the only place like this in the world.',
         'reactions': [('💐', 23), ('🩵', 11), ('👏', 7)]},
    ],
    ['Good Shots', 'Good Vibes', 'Good Tips', 'Hey Mirage']
)

# Feed 3: Good Tips
draw_feed_screenshot(
    'public/archive/screenshots/feed-03-good-tips.png',
    'Good Tips',
    'helpful info for festivalgoers — tips, lost and found, anything worth knowing',
    [
        {'nickname': 'sandyowl_14', 'location': 'in the desert', 'text': 'I-10 westbound backed up past cathedral city, take highway 111.',
         'reactions': [('💐', 9), ('🩵', 3)]},
        {'nickname': 'dustcreek_9', 'location': 'at the fest', 'text': 'main stage set starting 10 minutes late. confirmed by staff at the rail.',
         'reactions': [('💐', 6), ('👏', 2)]},
        {'nickname': 'saltflat_3', 'location': 'at the fest', 'text': 'medical tent near the east entrance is clear right now if anyone needs it.',
         'reactions': [('💐', 14), ('🩵', 8)]},
    ],
    ['Good Shots', 'Good Vibes', 'Good Tips', 'Hey Mirage']
)

# Feed 4: Hey Mirage
draw_feed_screenshot(
    'public/archive/screenshots/feed-04-hey-mirage.png',
    'Hey Mirage',
    'private note to team mirage',
    [],
    ['Good Shots', 'Good Vibes', 'Good Tips', 'Hey Mirage']
)

# Add the Hey Mirage special content
img = Image.open('public/archive/screenshots/feed-04-hey-mirage.png')
draw = ImageDraw.Draw(img)
font = make_font(13)
font_small = make_font(11)
font_large = make_font(16, bold=True)

# Card for Hey Mirage
card_top = 200
draw_rounded_rect = lambda d, xy, r, fill, outline=None, w=1: None

# Simpler approach - just draw rectangles
draw.rectangle([16, card_top, WIDTH-16, card_top + 180], fill=WHITE, outline=BORDER)
draw.text((28, card_top + 16), '✉ private note', fill=SKY_BLUE, font=font_small)
draw.text((28, card_top + 38), 'only the Mirage team sees this', fill=INK_MUTED, font=font_small)
draw.rectangle([28, card_top + 70, WIDTH-28, card_top + 130], fill=LIGHT_BLUE, outline=BORDER)
draw.text((36, card_top + 82), 'leave feedback, ideas,', fill=INK_MUTED, font=font)
draw.text((36, card_top + 100), 'anything you want heard...', fill=INK_MUTED, font=font)
draw.rectangle([WIDTH-100, card_top + 145, WIDTH-28, card_top + 168], fill=SKY_BLUE)
draw.text((WIDTH-88, card_top + 148), 'send →', fill=WHITE, font=font_small)

img.save('public/archive/screenshots/feed-04-hey-mirage.png')
print('Updated: feed-04-hey-mirage.png')

print('\nAll screenshots generated!')