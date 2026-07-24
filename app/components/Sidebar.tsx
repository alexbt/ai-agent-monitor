"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const groups = [
  {
    title: "Claude",
    items: [
      { href: "/visual", label: "Office View", icon: "🏢" },
      { href: "/claude", label: "Session Log", icon: "☰" },
      { href: "/status", label: "Status", icon: "📊" },
    ],
  },
  {
    title: "Codex",
    items: [
      { href: "/codex/visual", label: "Office View", icon: "🏢" },
      { href: "/codex", label: "Session Log", icon: "☰" },
      { href: "/codex/status", label: "Status", icon: "📊" },
    ],
  },
];

export default function Sidebar() {
  const pathname = usePathname();
  return (
    <aside className="sidebar">
      <div className="sidebar-brand">AI Agent Monitor</div>
      <nav>
        {groups.map((group) => (
          <div key={group.title} className="nav-group">
            <div className="nav-group-title">{group.title}</div>
            {group.items.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={`nav-item ${pathname === item.href ? "current" : ""}`}
              >
                <span className="nav-icon">{item.icon}</span>
                {item.label}
              </Link>
            ))}
          </div>
        ))}
      </nav>
    </aside>
  );
}
