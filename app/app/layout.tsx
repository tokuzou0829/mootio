import { headers } from "next/headers";
import Image from "next/image";

import { NavBar } from "@/components/nav-bar";
import { auth } from "@/lib/auth";

export default async function Nav({ children }: { children: React.ReactNode }) {
	let userId: string | undefined;

	try {
		const session = await auth.api.getSession({
			headers: await headers(),
		});
		userId = session?.user.id;
	} catch (error) {
		console.error("Failed to get session in app layout Nav", error);
	}

	return (
		<>
			<Image
				alt=""
				src={"/signup/bg-pattern.svg"}
				className="pointer-events-none absolute left-1/2 top-87.5 max-w-110 -translate-x-1/2 -translate-y-1/2 w-full"
				width={420}
				height={420}
			/>
			{children}
			<div className="fixed bottom-10 left-1/2 z-30 -translate-x-1/2">
				<NavBar userId={userId} />
			</div>
		</>
	);
}
