import { Elysia, t } from 'elysia'
import { notFound } from '../../lib/errors'

/*
 * The web client's /legal pages (and /privacy, /terms…) load their text from here. openitd has one document:
 * the page about this copy, under the privacy slug the footer links to. Other slugs answer 404.
 */

type Block = { type: 'heading'; level: 2 | 3; text: string } | { type: 'paragraph'; text: string } | { type: 'list' | 'lines'; items: string[] }

const heading = (text: string): Block => ({ type: 'heading', level: 2, text })
const paragraph = (text: string): Block => ({ type: 'paragraph', text })

const PRIVACY = {
  slug: 'privacy',
  title: 'Политика конфиденциальности',
  summary: 'Неофициальная копия ИТД для тестов: права, ответственность, данные и контакты',
  version: '1',
  documentDate: '2026-10-06',
  publishedAt: '2026-10-06T00:00:00.000Z',
  blocks: [
    heading('1. Общие положения'),
    paragraph(
      'Настоящий сайт (далее — «Сайт») является неофициальной копией социальной сети «итд». Сайт не связан с ООО «ИТД», не одобрен им и не поддерживается им.'
    ),
    heading('2. Права на объекты интеллектуальной собственности'),
    paragraph(
      'Все права на дизайн, интерфейс, наименования, логотипы, графические материалы и иные объекты интеллектуальной собственности социальной сети «итд» принадлежат ООО «ИТД». Администрация Сайта не претендует на указанные права.'
    ),
    heading('3. Назначение Сайта'),
    paragraph(
      'Сайт предназначен исключительно для тестирования и экспериментов. Сайт не является средством связи и не может использоваться для общения, а также для передачи личной или иной значимой информации.'
    ),
    heading('4. Ограничение ответственности'),
    paragraph(
      'Сайт предоставляется «как есть». Администрация не гарантирует бесперебойную работу Сайта и не несёт ответственности за сохранность аккаунтов, публикаций, комментариев, файлов и иных данных, а также за их утрату, изменение или раскрытие. Любые данные могут быть удалены в любой момент без предварительного уведомления.'
    ),
    heading('5. Данные пользователей'),
    paragraph(
      'Для работы Сайта хранятся ник в Telegram, номер телефона (если вы его привязали), хэш пароля, опубликованные материалы и технические сведения о сессиях (IP-адрес, сведения об устройстве). Не размещайте на Сайте персональные данные и сведения, утрата или раскрытие которых для вас нежелательны.'
    ),
    heading('6. Сведения о разработке'),
    paragraph(
      'Серверная часть (бэкенд) Сайта сгенерирована с помощью искусственного интеллекта. Клиентская часть (фронтенд) Сайта представляет собой декомпилированный бандл, полученный с сайта оригинальной социальной сети.'
    ),
    heading('7. Контактная информация'),
    {
      type: 'lines',
      items: ['Канал проекта в Telegram: [@openitd](https://t.me/openitd)', 'Связь с автором: [@nwokez](https://t.me/nwokez)']
    }
  ] satisfies Block[]
}

const DOCUMENTS = [PRIVACY]
const find = (slug: string) => {
  const document = DOCUMENTS.find((d) => d.slug === slug)
  if (!document) throw notFound('Документ не найден', 'NOT_FOUND')
  return document
}
const versionOf = (d: typeof PRIVACY) => ({ version: d.version, title: d.title, documentDate: d.documentDate, publishedAt: d.publishedAt, current: true })

export const legalModule = new Elysia({ prefix: '/legal-documents', tags: ['Platform'] })
  .get('/', () => ({ documents: DOCUMENTS.map(({ blocks: _, ...d }) => ({ ...d, url: `/legal/${d.slug}`, current: true })) }), {
    query: t.Object({ scope: t.Optional(t.String({ maxLength: 32 })) }),
    detail: { summary: 'Legal documents (openitd: the page about this copy)' }
  })
  .get('/:scope/:slug', ({ params }) => ({ document: { ...find(params.slug), current: true } }), {
    params: t.Object({ scope: t.String({ maxLength: 32 }), slug: t.String({ maxLength: 64 }) })
  })
  .get('/:scope/:slug/versions', ({ params }) => ({ versions: [versionOf(find(params.slug))] }), {
    params: t.Object({ scope: t.String({ maxLength: 32 }), slug: t.String({ maxLength: 64 }) })
  })
  .get(
    '/:scope/:slug/versions/:version',
    ({ params }) => {
      const document = find(params.slug)
      if (params.version !== document.version) throw notFound('Документ не найден', 'NOT_FOUND')
      return { document: { ...document, current: true } }
    },
    { params: t.Object({ scope: t.String({ maxLength: 32 }), slug: t.String({ maxLength: 64 }), version: t.String({ maxLength: 16 }) }) }
  )
