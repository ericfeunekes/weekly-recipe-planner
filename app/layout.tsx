import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host =
    requestHeaders.get("x-forwarded-host") ??
    requestHeaders.get("host") ??
    "localhost:3001";
  const protocol =
    requestHeaders.get("x-forwarded-proto") ??
    (host.startsWith("localhost") ? "http" : "https");
  const imageUrl = `${protocol}://${host}/og.png`;

  return {
    title: "Weekly Recipe Planner",
    description:
      "A local-first weekly meal planning surface for meals, prep, groceries, leftovers, and household feedback.",
    openGraph: {
      title: "Weekly Recipe Planner",
      description: "Keep the whole cooking week under control.",
      type: "website",
      images: [
        {
          url: imageUrl,
          width: 1731,
          height: 909,
          alt: "Weekly Recipe Planner week board",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: "Weekly Recipe Planner",
      description: "Keep the whole cooking week under control.",
      images: [imageUrl],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
