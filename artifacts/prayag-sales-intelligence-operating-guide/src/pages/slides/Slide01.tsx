import appNav from '@assets/image_1789127552577.png';
export default function Slide01(){return <div className="w-screen h-screen overflow-hidden relative bg-[#0B2545] text-[#F6F8FB] font-body">
  <div className="absolute inset-0 bg-[radial-gradient(circle_at_82%_18%,rgba(22,118,197,0.46),transparent_34%),linear-gradient(135deg,#0B2545_0%,#102F53_65%,#0B2545_100%)]" />
  <div className="absolute left-[5vw] top-[7vh] text-[1.5vw] font-bold tracking-[0.24em] text-[#7EC8F5]">PRAYAG INDIA · MANAGEMENT EDITION</div>
  <div className="absolute left-[5vw] top-[18vh] w-[63vw]">
    <h1 className="font-display text-[6.2vw] leading-[0.93] tracking-[-0.05em] font-extrabold">{`Prayag Sales Intelligence`}</h1>
    <div className="mt-[4vh] h-[0.7vh] w-[12vw] bg-[#F2A900]" />
    <p className="mt-[4vh] text-[2.25vw] leading-[1.25] text-[#DDEAF5]">{`A 60-slide operating guide to every dashboard, calculation, decision, and alert`}</p>
    <p className="mt-[1.5vh] text-[1.7vw] font-semibold text-[#7EC8F5]">{`FY2026–27 management edition`}</p>
  </div>
  <div className="absolute left-[5vw] right-[5vw] bottom-[7vh] bg-[#F6F8FB] p-[1.2vw] shadow-2xl">
    <img src={appNav} crossOrigin="anonymous" className="w-full h-[12vh] object-cover object-left" alt="Prayag Sales Intelligence navigation" />
  </div>
</div>}