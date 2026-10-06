#!/usr/bin/env python3
"""
Probes how the official ITD backend validates red pen and corrector requests.

Every request is deliberately wrong in one way. With an empty red pen / corrector balance nothing can be applied:
a request either fails one of the checks (its code and message are printed) or reaches the balance check
("not enough items"), which means it passed every check before that one. The script refuses to run while the
account owns red pens or correctors.

    pip install requests
    python3 scripts/probe_post_tools.py --token <access token> --post <someone else's post id> [--own-post <your post id>]

The access token: итд.com → F12 → Network → any /api/ request → the Authorization header, without "Bearer ".
Pick a post of another user with a few plain words in its text (ideally a mention or a link too).
"""

import argparse
import json
import re
import sys
import time
import uuid

import requests

WORD = re.compile(r"[^\W\d_]+(?:[-'’][^\W\d_]+)*")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--token', required=True)
    parser.add_argument('--post', required=True, help="someone else's post")
    parser.add_argument('--own-post', help='your own post (checks the "own post" rule)')
    parser.add_argument('--base', default='https://xn--d1ah4a.com')
    parser.add_argument('--delay', type=float, default=1.5, help='seconds between requests')
    parser.add_argument('--out', default='probe-results.json')
    args = parser.parse_args()

    session = requests.Session()
    session.headers.update({
        'Authorization': f'Bearer {args.token}',
        'Content-Type': 'application/json',
        'Origin': args.base,
        'Referer': f'{args.base}/',
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
    })

    def get(path):
        res = session.get(args.base + '/api' + path, timeout=30)
        res.raise_for_status()
        return res.json()

    # never spend real items
    pens = get('/red-pens/inventory')['data']['events']
    paints = get('/correctors/inventory')['data']['events']
    owned = sum(e.get('balance', 0) for e in pens + paints)
    if owned:
        sys.exit(f'The account has {owned} red pens/correctors: a valid probe would spend one. Use an account without them.')

    post = get(f'/posts/{args.post}')['data']
    text = post['content']
    pen_state = post.get('redPen') or {}
    paint_state = post.get('corrector') or {}
    if not pen_state or not paint_state:
        sys.exit('The post has no redPen/corrector state: the event is not running for it.')
    revision = pen_state['revision']
    event_id = pen_state['events'][0]['id']
    print(f'post text ({len(text)} chars): {text!r}')
    print(f'revision {revision}, event {event_id}\n')

    words = [(m.start(), m.end()) for m in WORD.finditer(text)]
    if len(words) < 2:
        sys.exit('Pick a post with at least two words.')
    (w1s, w1e), (w2s, w2e) = words[0], words[1]
    word = text[w1s:w1e]
    spans = [s for s in post.get('spans') or [] if s.get('type') in ('link', 'mention', 'hashtag', 'spoiler')]

    def body(start, end, replacement=None, **extra):
        data = {'eventId': event_id, 'postId': args.post, 'revision': revision, 'start': start, 'end': end, 'operationId': str(uuid.uuid4())}
        if replacement is not None:
            data['replacement'] = replacement
        data.update(extra)
        return data

    pen_cases = [
        ('valid request (expect: not enough red pens)', body(w1s, w1e, 'тест' if word != 'тест' else 'проба')),
        ('stale revision', body(w1s, w1e, 'тест', revision='0' * 64)),
        ('unknown event', body(w1s, w1e, 'тест', eventId='no-such-event')),
        ('unknown post', body(w1s, w1e, 'тест', postId=str(uuid.uuid4()))),
        ('end beyond the text', body(0, len(text) + 5, 'тест')),
        ('start == end', body(w1s, w1s, 'тест')),
        ('negative start', body(-1, w1e, 'тест')),
        ('part of a word', body(w1s + 1, w1e, 'тест') if w1e - w1s > 1 else None),
        ('two words', body(w1s, w2e, 'тест')),
        ('word with the space after it', body(w1s, w1e + 1, 'тест') if w1e < len(text) else None),
        ('no replacement', body(w1s, w1e)),
        ('empty replacement', body(w1s, w1e, '')),
        ('replacement with a space', body(w1s, w1e, 'два слова')),
        ('replacement of 11 letters', body(w1s, w1e, 'абвгдеёжзий')),
        ('replacement of 10 letters', body(w1s, w1e, 'абвгдеёжзи')),
        ('replacement with digits', body(w1s, w1e, 'тест123')),
        ('replacement with punctuation', body(w1s, w1e, 'тест!')),
        ('replacement with a hyphen', body(w1s, w1e, 'как-то')),
        ('replacement in latin', body(w1s, w1e, 'hello')),
        ('replacement in greek', body(w1s, w1e, 'γεια')),
        ('replacement with an emoji', body(w1s, w1e, 'тест😀')),
        ('replacement equal to the word', body(w1s, w1e, word)),
        ('replacement equal, other case', body(w1s, w1e, word.upper() if word.upper() != word else word.lower())),
    ]
    for span in spans[:2]:
        pen_cases.append((f"word inside a {span['type']}", body(span['offset'], span['offset'] + span['length'], 'тест')))
    if args.own_post:
        own = get(f'/posts/{args.own_post}')['data']
        own_words = [(m.start(), m.end()) for m in WORD.finditer(own['content'])]
        if own_words:
            s, e = own_words[0]
            pen_cases.append(('own post', body(s, e, 'тест', postId=args.own_post, revision=own['redPen']['revision'])))

    paint_revision = paint_state['revision']

    def end_after(count):
        # end of the shortest prefix with `count` non-space characters
        seen = 0
        for index, char in enumerate(text):
            seen += not char.isspace()
            if seen == count:
                return index + 1
        return None

    ten, eleven = end_after(10), end_after(11)
    paint_cases = [
        ('valid request (expect: not enough correctors)', body(w1s, w1e, revision=paint_revision)),
        ('stale revision', body(w1s, w1e, revision='0' * 64)),
        ('only spaces', body(w1e, w1e + 1, revision=paint_revision) if text[w1e:w1e + 1].isspace() else None),
        ('11 non-space characters', body(0, eleven, revision=paint_revision) if eleven else None),
        ('10 non-space characters', body(0, ten, revision=paint_revision) if ten else None),
        ('whole text', body(0, len(text), revision=paint_revision)),
        ('two words with a space', body(w1s, w2e, revision=paint_revision)),
    ]
    if args.own_post:
        own = get(f'/posts/{args.own_post}')['data']
        paint_cases.append(('own post', body(0, min(3, len(own['content'])), postId=args.own_post, revision=own['corrector']['revision'])))

    results = []
    for path, cases in (('/red-pens/apply', pen_cases), ('/correctors/apply', paint_cases)):
        print(f'== {path}')
        for name, data in cases:
            if data is None:
                continue
            res = session.post(args.base + '/api' + path, data=json.dumps(data), timeout=30)
            try:
                reply = res.json()
            except ValueError:
                reply = res.text[:200]
            error = reply.get('error', reply) if isinstance(reply, dict) else reply
            code = error.get('code') if isinstance(error, dict) else None
            message = error.get('message') if isinstance(error, dict) else error
            print(f'{res.status_code}  {name:<40} {code or "-":<28} {message}')
            results.append({'endpoint': path, 'case': name, 'request': data, 'status': res.status_code, 'response': reply})
            time.sleep(args.delay)
        print()

    with open(args.out, 'w', encoding='utf-8') as file:
        json.dump(results, file, ensure_ascii=False, indent=2)
    print(f'saved {args.out}')


if __name__ == '__main__':
    main()
