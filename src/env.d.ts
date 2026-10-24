/// <reference types="astro/client" />
declare namespace App {
  interface Locals {
    scriptHashes?: string[];
    ip: string;
    session: { token: string; csrf: string; expires: number } | null;
  }
}
