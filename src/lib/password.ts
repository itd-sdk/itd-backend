import bcrypt from 'bcrypt'
import { config } from '../config'

export const hashPassword = (password: string) => bcrypt.hash(password, config.auth.bcryptRounds)

// an empty hash marks an account created by phone that has no password yet
export const verifyPassword = async (password: string, hash: string) => !!hash && (await bcrypt.compare(password, hash))

/** 8..128 printable ASCII characters: everything the official client lets through */
export function isValidPassword(password: string) {
  return password.length >= 8 && password.length <= 128 && /^[\x21-\x7E]+$/.test(password)
}
