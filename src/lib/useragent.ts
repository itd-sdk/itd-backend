export type DeviceInfo = {
  deviceType: 'desktop' | 'mobile'
  osName: string
  osVersion: number | null
  deviceModel: string | null
  clientName: string | null
  clientVersion: string | null
}

const major = (value: string | undefined) => {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) ? parsed : null
}

const WINDOWS_NT: Record<string, number> = { '10.0': 10, '6.3': 8, '6.2': 8, '6.1': 7 }

export function parseUserAgent(ua: string | null | undefined): DeviceInfo {
  const value = ua ?? ''
  const info: DeviceInfo = { deviceType: 'desktop', osName: 'Unknown', osVersion: null, deviceModel: null, clientName: null, clientVersion: null }

  let match: RegExpMatchArray | null
  if ((match = value.match(/Android (\d+)/))) {
    info.osName = 'Android'
    info.osVersion = major(match[1])
    info.deviceType = 'mobile'
  } else if ((match = value.match(/(?:iPhone|CPU) OS (\d+)/)) || /iPhone|iPad|iPod/.test(value)) {
    info.osName = 'iOS'
    info.osVersion = major(match?.[1])
    info.deviceType = 'mobile'
  } else if ((match = value.match(/Windows NT (\d+\.\d+)/))) {
    info.osName = 'Windows'
    info.osVersion = WINDOWS_NT[match[1]!] ?? major(match[1])
  } else if ((match = value.match(/Mac OS X (\d+)/))) {
    info.osName = 'macOS'
    info.osVersion = major(match[1])
  } else if (/CrOS/.test(value)) {
    info.osName = 'ChromeOS'
  } else if (/Linux/.test(value)) {
    info.osName = 'Linux'
  }
  if (/Mobile|Android|iPhone|iPod/.test(value)) info.deviceType = 'mobile'

  const clients: [RegExp, string][] = [
    [/itd-sdk\/([\w.-]+)/, 'itd-sdk'],
    [/ITD(?:-| )?(?:Android|iOS|App)\/([\w.-]+)/i, 'ITD App'],
    [/YaBrowser\/([\d.]+)/, 'Yandex Browser'],
    [/Edg(?:e|A|iOS)?\/([\d.]+)/, 'Edge'],
    [/OPR\/([\d.]+)/, 'Opera'],
    [/Firefox\/([\d.]+)/, 'Firefox'],
    [/FxiOS\/([\d.]+)/, 'Firefox'],
    [/CriOS\/([\d.]+)/, 'Chrome'],
    [/Chrome\/([\d.]+)/, 'Chrome'],
    [/Version\/([\d.]+).*Safari/, 'Safari'],
    [/python-requests\/([\d.]+)/, 'python-requests'],
    [/curl\/([\d.]+)/, 'curl']
  ]
  for (const [regex, name] of clients) {
    if ((match = value.match(regex))) {
      info.clientName = name
      info.clientVersion = match[1] ?? null
      break
    }
  }
  return info
}
