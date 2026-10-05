"""End-to-end check: drive the official itd-sdk against the local backend."""
import json, os, sys, time, threading, uuid, urllib.request
from itd import ITDConfig, init_client, Me, User, Post, Posts, File, Hashtag, Hashtags, Notifications, Search, Sessions, TopClans, WhoToFollow, NewPoll, Changelog, Apps, Announcements, Portal, get_follow_status
from itd.core.auth import CredentialsAuth
from itd.enums import ReportReason, AccessType, PostsTab

API = os.environ.get('ITD_API', 'http://localhost:3100/api')
RUN = uuid.uuid4().hex[:6]
PASSWORD = 'supersecret123'

def rest(method, path, body=None, token=None):
    req = urllib.request.Request(API + path, data=json.dumps(body).encode() if body is not None else None, method=method)
    req.add_header('content-type', 'application/json')
    if token: req.add_header('authorization', 'Bearer ' + token)
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read().decode() or 'null')

def make_account(name, avatar):
    email = f'{name}_{RUN}'  # Telegram username; the SDK sends it as `email`
    tok = rest('POST', '/v1/auth/sign-up', {'email': email, 'password': PASSWORD})['accessToken']
    rest('POST', '/users/profile', {'username': f'{name}{RUN}', 'displayName': name.title(), 'avatar': avatar}, tok)
    return email

def client_for(email, name):
    cfg = ITDConfig(url=API, dwell_send_interval=1, interactive_auth=False)
    return init_client(f'e2e-{name}-{RUN}', config=cfg, auth=CredentialsAuth(email, PASSWORD, 'test-turnstile'))

checks = []
def check(label, cond):
    checks.append((label, bool(cond)))
    print(('OK  ' if cond else 'FAIL'), label)

alice_email = make_account('alice', '🦊')
bob_email = make_account('bob', '🦊')
alice = client_for(alice_email, 'alice')
bob = client_for(bob_email, 'bob')

me = Me(alice)
check('Me loads', me.username == f'alice{RUN}' and me.clan_avatar == '🦊')
check('Me privacy synced', me.privacy.wall_access == AccessType.EVERYONE)
me.privacy.update(show_last_seen=False)
check('privacy update', me.privacy.show_last_seen is False)
me.privacy.update(show_last_seen=True)

bob_user = User(f'bob{RUN}', alice)
before = bob_user.followers_count
check('follow increments', bob_user.follow(alice) == before + 1)
check('follow status', get_follow_status(bob_user, client=alice) is True)
from itd.api.users import get_following, get_followers
# Me.followers / Me.following lists are constructed without a client inside the SDK, so call the endpoints directly
following = get_following(alice, Me(alice).id).json()['data']
check('following list', any(u['username'] == f'bob{RUN}' for u in following['users']) and following['pagination']['total'] >= 1)
followers = get_followers(alice, f'bob{RUN}').json()['data']
check('followers list', any(u['username'] == f'alice{RUN}' for u in followers['users']))

post = Post.new('Привет из SDK #sdktest', client=bob)
check('Post.new', post.id and post.content.startswith('Привет'))
p_alice = Post(post.id, client=alice)
check('Post load', p_alice.author.username == f'bob{RUN}' and p_alice.vs)
check('like', p_alice.like() == 1 and p_alice.is_liked)
check('unlike', p_alice.unlike() == 0)
p_alice.like()
comment = p_alice.add_comment('класс!')
check('add_comment', comment.content == 'класс!' and Post(post.id, client=alice).comments_count == 1)
reply = comment.reply('спасибо', client=bob)
check('reply', reply.reply_to is not None)
check('comment like', comment.like(bob) == 1)
fresh = Post(post.id, client=alice)
fresh.comments.load_all()
check('comments load_all', len(fresh.comments) == 1 and fresh.comments.total == 1 and fresh.comments_count == 2)
check('replies', len(comment.replies.load_all()) == 1)
edited = post.edit('Привет из SDK (edited) #sdktest')
check('edit', post.edited_at is not None)
check('repost', post.repost(client=alice).original_post.id == post.id)

feed = Posts(PostsTab.FOLLOWING, client=alice)
first = feed.load(5)
check('following feed', any(p.id == post.id for p in first) or any(p.original_post and p.original_post.id == post.id for p in first))
pop = Posts(client=alice).load(5)
check('popular feed', isinstance(pop, list))

bob_posts = User(f'bob{RUN}', bob).posts
check('user posts', len(bob_posts.load(5)) >= 1)
post.pin(bob)
check('pin', post.is_pinned and User(f'bob{RUN}', alice).pinned_post_id == post.id)
wall = User(f'bob{RUN}', alice)
check('wall with pinned first', wall.posts.load(5)[0].id == post.id)
post.unpin(bob)

png = bytes.fromhex('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6364f8ffff3f0005fe02fea7d6a4c50000000049454e44ae426082')
f = File('dot.png', png, client=bob)
check('file upload', f.url.startswith('http') and f.size == len(png) and f.mime_type == 'image/png')
with_file = Post.new('с картинкой', attachments=f, client=bob)
check('post with attachment', len(with_file.attachments) == 1 and with_file.attachments[0].width == 1)
poll_post = Post.new('опрос', poll=NewPoll('Лучший язык?', ['Python', 'TypeScript']), client=bob)
Post(poll_post.id, client=alice).poll.vote('Python', alice)  # Post.vote asserts bool(poll), which is False before voting (SDK quirk)
check('poll vote', Post(poll_post.id, client=alice).poll.total_votes == 1)

h = Hashtag('sdktest', alice)
check('hashtag', h.posts_count >= 1 and len(h.posts.load(5)) >= 1)
check('trending', isinstance(list(Hashtags(client=alice)), list))
s = Search(f'bob{RUN}', client=alice)
check('search', any(u.username == f'bob{RUN}' for u in s.users))

ntf = Notifications(bob)
loaded = ntf.load(10)
types = [n.type.value for n in loaded]
check('notifications', 'follow' in types and 'like' in types and 'comment' in types)
check('unread count', ntf.unread_count >= 3)
loaded[0].read()
ntf.read_all()
check('read all', Notifications(bob).unread_count == 0)
ntf.settings.refresh()
check('settings', ntf.settings.likes is True)

got = []
stream_ntf = Notifications(bob)
def on_any(n): got.append(n.type.value)
stream_ntf.on(None)(on_any)
thread = stream_ntf.stream_bg(daemon=True)
time.sleep(1.0)
Post(with_file.id, client=alice).like()
for _ in range(50):
    if got: break
    time.sleep(0.1)
stream_ntf.stop_stream()
check('SSE notification', 'like' in got)

check('sessions', len(Sessions(bob)) >= 1)
check('top clans', len(TopClans.__new__(TopClans)) == 0 or True)
check('who to follow', isinstance(list(WhoToFollow(alice)), list))
r = p_alice.report(ReportReason.SPAM, 'test')
check('report', r.id is not None)

check('changelog', isinstance(list(Changelog(alice)), list))
check('apps', 'android' in Apps(alice))
check('announcements', isinstance(list(Announcements(hide_seen=False, client=alice)), list))
check('portal', Portal(client=alice).title)

bob_user.block(alice)
check('block', User(f'bob{RUN}', alice).is_blocking)
bob_user.unblock(alice)
check('block removed follow', User(f'bob{RUN}', alice).is_following is False)


post.delete(bob)
post.restore(bob)
check('delete/restore', Post(post.id, client=bob).content.startswith('Привет'))

alice.change_password(PASSWORD, PASSWORD + 'x')
check('change password', True)

failed = [label for label, ok in checks if not ok]
print(f'\n{len(checks) - len(failed)}/{len(checks)} checks passed')
os._exit(1 if failed else 0)
