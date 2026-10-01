import type { Metadata } from "next";
import Link from "next/link";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Caselaw Agent",
  description: "Natural-language search over UK judgments from The National Archives' Find Case Law",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col font-sans">
        <header className="sticky top-0 z-20 border-b border-border bg-background/90 backdrop-blur">
          <nav className="mx-auto flex max-w-6xl items-center gap-6 px-4 py-3 text-sm">
            <Link href="/" className="font-semibold tracking-tight">
              Caselaw<span className="text-accent">Agent</span>
            </Link>
            <Link href="/" className="text-muted hover:text-foreground">Search</Link>
            <Link href="/cases" className="text-muted hover:text-foreground">Cached cases</Link>
          </nav>
        </header>
        <main className="flex-1">{children}</main>
        <footer className="border-t border-border px-4 py-4 text-center text-xs text-muted">
          Not legal advice. Source: The National Archives, Find Case Law — Open Justice Licence.
        </footer>
      </body>
    </html>
  );
}
