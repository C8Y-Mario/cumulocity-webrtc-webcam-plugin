import { Component } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { FetchClient } from '@c8y/client';
import {
  combineLatest,
  distinctUntilChanged,
  filter,
  from,
  fromEvent,
  interval,
  map,
  merge,
  NEVER,
  Observable,
  of,
  pairwise,
  retry,
  share,
  startWith,
  switchMap,
  takeUntil,
  tap
} from 'rxjs';
import { IceServerConfigurationService } from '../ice-server-configuration.service';
import { signalingConnection } from './signaling.service';
import { ContextRouteService, ViewContext } from '@c8y/ngx-components';

enum WebRTCSignalingMessageTypes {
  offer = 'webrtc/offer',
  candidate = 'webrtc/candidate',
  answer = 'webrtc/answer',
}

interface RCAConfiguration {
  id: number
  hostname: string
  port: number,
  stream: string
}

@Component({
  selector: 'app-webrtc-webcam',
  templateUrl: './webcam.component.html',
  providers: [],
  standalone: false
})
export class WebcamComponent {
  mediaStream$: Observable<MediaStream> | undefined;
  connecting = false;

  constructor(
    private activatedRoute: ActivatedRoute,
    private iceConfig: IceServerConfigurationService,
    private fetch: FetchClient,
    private contextRouteService: ContextRouteService
  ) {
  }

  private getRCAConfig(entryId: number, activatedRoute: ActivatedRoute): RCAConfiguration | undefined {
    const data = this.contextRouteService.getContextData(activatedRoute);
    if (!data) {
      return undefined;
    }
    const { context, contextData: device } = data;
    if (context === ViewContext.Device) {
      const { c8y_RemoteAccessList: remoteAccessList } = device;
      if (!remoteAccessList || !Array.isArray(remoteAccessList)) {
        return undefined;
      }

      const webcamEntry = remoteAccessList.filter(
        ({ name, id }) =>
          typeof name === 'string' && name.toLowerCase().includes('webcam') && id === entryId
      )[0];
      if (webcamEntry) {
        const stream = webcamEntry.name.startsWith('webcam:') ? webcamEntry.name.replace('webcam:', '') : webcamEntry.name;
        return {
          id: webcamEntry.id,
          hostname: webcamEntry.hostName,
          port: webcamEntry.port,
          stream: stream
        };
      }
    }
    return undefined
  }

  play() {
    const rcaConfig$ = this.activatedRoute.params.pipe(
      map((params) => this.getRCAConfig(params['rcaId'], this.activatedRoute)),
      filter(Boolean),
      distinctUntilChanged()
    );
    const deviceId$ =
      this.activatedRoute.parent?.data.pipe(
        map((data) => data['contextData']['id']),
        filter(Boolean),
        distinctUntilChanged()
      ) || NEVER;

    this.mediaStream$ = combineLatest([deviceId$, rcaConfig$]).pipe(
      switchMap(([deviceId, rcaConfig]) => {
        return this.call(deviceId, rcaConfig).pipe(retry({delay:1000}));
      })
    );
  }

  stop() {
    this.mediaStream$ = undefined;
    this.connecting = false;
  }

  private call(deviceId: string, rcaConfig: RCAConfiguration): Observable<MediaStream | undefined> {
    const { token, xsrf } = this.getToken();
    const peerConnection$ = from(this.iceConfig.getIceServers()).pipe(
      switchMap((servers) => {
        this.connecting = true;
        return new Observable<RTCPeerConnection>((observer) => {
          const peerConnection = new RTCPeerConnection({
            iceServers: servers,
            iceCandidatePoolSize: 10,
          });
          observer.next(peerConnection);

          return {
            unsubscribe: () => {
              peerConnection.close();
            },
          };
        }).pipe(share());
      })
    );

    const mediaStreamAndPeerConnection$ = peerConnection$.pipe(
      switchMap((peerConnection) => {
        const mediaStream = new MediaStream();
        const track$ = fromEvent<RTCTrackEvent>(peerConnection, 'track').pipe(
          tap((event) => {
            event.streams[0].getTracks().forEach((track) => {
              mediaStream.addTrack(track);
            });
          })
        );

        return merge(
          of({ mediaStream, peerConnection }),
          merge(track$).pipe(switchMap(() => NEVER))
        );
      })
    );

    const details$ = mediaStreamAndPeerConnection$.pipe(
      switchMap(({ mediaStream, peerConnection }) => {
        const signaling = signalingConnection({
          deviceId,
          configId: rcaConfig.id.toString(),
          token,
          xsrf,
          host: rcaConfig.hostname,
          port: rcaConfig.port.toString(),
          webcam: rcaConfig.stream,
        });

        const connectionState$ = fromEvent<Event>(
          peerConnection,
          'connectionstatechange'
        ).pipe(
          startWith(null),
          tap(_ => this.connecting = peerConnection.connectionState != 'connected'),
          map(() => {
            return peerConnection.connectionState;
          })
        );

        const canCloseSignalingConnection$ = connectionState$.pipe(
          filter((state) => {
            return (
              state === 'connected' ||
              state === 'failed' ||
              state === 'closed' ||
              state === 'disconnected'
            );
          })
        );

        const signalingMessages$ = signaling.pipe(
          takeUntil(canCloseSignalingConnection$),
          tap((msg) => {
            try {
              const parsed = JSON.parse(msg);
              if (parsed.type === WebRTCSignalingMessageTypes.answer) {
                peerConnection.setRemoteDescription(
                  new RTCSessionDescription({
                    type: 'answer',
                    sdp: parsed.value,
                  })
                );
              } else if (
                parsed.type === WebRTCSignalingMessageTypes.candidate
              ) {
                peerConnection
                  .addIceCandidate({ candidate: parsed.value, sdpMid: '0' })
                  .catch((tmp) => console.error(tmp));
              }
            } catch (e) {
              console.log(e);
              console.error(msg);
            }
          })
        );

        return merge(
          of({ mediaStream, signaling, peerConnection }),
          signalingMessages$.pipe(switchMap(() => NEVER))
        );
      })
    );

    return details$.pipe(
      switchMap(({ mediaStream, signaling, peerConnection }) => {
        const iceGatheringStateChange$ = fromEvent(
          peerConnection,
          'icegatheringstatechange'
        ).pipe(filter(() => peerConnection.iceGatheringState === 'complete'));

        const iceCandidate$ = fromEvent<RTCPeerConnectionIceEvent>(
          peerConnection,
          'icecandidate'
        ).pipe(
          tap((event) => {
            if (event.candidate) {
              signaling.send(
                JSON.stringify({
                  type: WebRTCSignalingMessageTypes.candidate,
                  value: event.candidate.toJSON().candidate,
                })
              );
            } else {
              signaling.send(
                JSON.stringify({
                  type: WebRTCSignalingMessageTypes.candidate,
                  value: '',
                })
              );
            }
          })
        );

        const createOffer$ = from(
          peerConnection.createOffer({
            offerToReceiveAudio: true,
            offerToReceiveVideo: true,
          })
        ).pipe(
          switchMap((offerDescription) => {
            signaling.send(
              JSON.stringify({
                type: WebRTCSignalingMessageTypes.offer,
                value: offerDescription?.sdp,
              })
            );
            return peerConnection.setLocalDescription(offerDescription);
          })
        );
        //observe the number of decoded frames, if it doesn't change for 2 seconds throw an error
        const frozenWatchdog$ = interval(2000).pipe(
          switchMap(_ => peerConnection.getStats()),
          map(stats => {
            let frames = -1;
            stats.forEach((report) => {
              if (report.type === 'inbound-rtp' && report.kind === 'video') {
                frames = report.framesDecoded;
              }
            })
            return frames}),
          pairwise(),
          tap(([a,b]) => {
            if (a > 0 && b > 0 && a == b) {throw new Error("Stream Frozen")}
          })
        );

        return merge(
          of(mediaStream),
          merge(createOffer$, iceCandidate$, iceGatheringStateChange$, frozenWatchdog$).pipe(
            switchMap(() => NEVER)
          )
        );
      })
    );
  }

  private getToken(): { token: string; xsrf: string } {
    const { headers } = this.fetch.getFetchOptions();
    let { Authorization: token, 'X-XSRF-TOKEN': xsrf } = headers;
    if (token) {
      token = token.replace('Basic ', '');
    }
    if (token) {
      return { token, xsrf };
    }

    return { token: '', xsrf };
  }
}
