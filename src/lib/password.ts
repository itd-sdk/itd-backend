import bcrypt from 'bcrypt'
import { config } from '../config'

export const hashPassword = (password: string) => bcrypt.hash(password, config.auth.bcryptRounds)

export const verifyPassword = (password: string, hash: string) => bcrypt.compare(password, hash)

/** 10..128 printable ASCII characters, same rule as the official client */
export function isValidPassword(password: string) {
  return password.length >= 10 && password.length <= 128 && /^[\x21-\x7E]+$/.test(password)
}
