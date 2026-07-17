import type { Metadata } from "next";
import { headers } from "next/headers";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
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
      "A shared household planner for meals, prep, groceries, leftovers, and family feedback.",
    icons: {
      icon: "/og.png",
      apple: "/og.png",
    },
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
      <body>
        <TooltipProvider>
          {children}
          <Toaster />
        </TooltipProvider>
      </body>
    </html>
  );
}
