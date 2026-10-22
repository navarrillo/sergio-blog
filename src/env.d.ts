/// <reference types="astro/client" />
declare namespace App {
  interface Locals {
    ip: string;
    session: { token: string; csrf: string; expires: number } | null;
  }
}
